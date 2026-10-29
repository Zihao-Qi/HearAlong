// macOS process ownership for one calculation. Process responsibility survives setsid(), reparenting and double forks.
// No process arguments, environments or user files are inspected. Missing ownership APIs fail closed.
// LIMIT: native code can spawn with a new responsibility identity; this is not hostile-process containment.
#include <dlfcn.h>
#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/proc_info.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
static int (*responsible)(int);
static int (*disclaim)(posix_spawnattr_t *, int);

static int sweep(void) {
    int capacity = proc_listallpids(NULL, 0) + 1024;
    pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
    if (!pids) return -1;
    int count = proc_listallpids(pids, capacity * (int)sizeof(pid_t)), found = 0;
    if (count <= 0 || count >= capacity) { free(pids); return -1; }
    for (int i = 0; i < count; i++) {
        pid_t pid = pids[i];
        if (pid <= 1 || pid == getpid() || responsible(pid) != getpid()) continue;
        struct proc_bsdinfo info;
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) continue;
        if (info.pbi_status == 5) continue; // SZOMB; it can neither fork nor execute.
        if (responsible(pid) != getpid()) continue; // Recheck ownership immediately before signalling.
        if (kill(pid, SIGKILL) == 0 || errno != ESRCH) found++;
    }
    free(pids);
    while (waitpid(-1, NULL, WNOHANG) > 0) {}
    return found;
}

// This sweep is deliberately not an ownership proof. Use only kernel metadata, same uid, an allowed executable,
// a sandboxed process and the exact task cwd. A hostile child can change cwd and escape this best-effort cleanup.
static int leftover_matches(pid_t pid, const char *cwd, const char *runtime, int argc, char **interpreters,
                            int (*sandbox_check_fn)(pid_t, const char *, int, ...), struct proc_bsdinfo *info) {
    char executable[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(pid, executable, sizeof(executable)) <= 0) return 0;
    size_t length = strlen(runtime);
    int allowed = !strncmp(executable, runtime, length) && executable[length] == '/';
    for (int i = 0; i < argc && !allowed; i++) allowed = !strcmp(executable, interpreters[i]);
    if (!allowed || sandbox_check_fn(pid, NULL, 0) <= 0) return 0;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info)) != sizeof(*info)
        || info->pbi_uid != geteuid() || info->pbi_status == 5) return 0;
    struct proc_vnodepathinfo paths;
    if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &paths, sizeof(paths)) != sizeof(paths)) return 0;
    return !strcmp(paths.pvi_cdir.vip_path, cwd);
}

static int best_effort(int argc, char **argv) {
    if (argc < 4) return 126;
    void *library = dlopen("/usr/lib/libsandbox.dylib", RTLD_LAZY);
    int (*check)(pid_t, const char *, int, ...) = library ? dlsym(library, "sandbox_check") : NULL;
    if (!check) { if (library) dlclose(library); return 126; }
    int capacity = proc_listallpids(NULL, 0) + 1024;
    pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
    if (!pids) { dlclose(library); return 126; }
    int count = proc_listallpids(pids, capacity * (int)sizeof(pid_t)), killed = 0;
    if (count <= 0 || count >= capacity) { free(pids); dlclose(library); return 126; }
    for (int i = 0; i < count; i++) {
        pid_t pid = pids[i];
        if (pid <= 1 || pid == getpid()) continue;
        struct proc_bsdinfo before, after;
        if (!leftover_matches(pid, argv[2], argv[3], argc - 4, &argv[4], check, &before)) continue;
        // Recheck uid/executable/cwd/sandbox and process birth time immediately before signalling to avoid reused pids.
        if (!leftover_matches(pid, argv[2], argv[3], argc - 4, &argv[4], check, &after)
            || before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec) continue;
        if (kill(pid, SIGKILL) == 0) killed++;
    }
    free(pids); dlclose(library);
    printf("%d\n", killed);
    return 0;
}

static int own(char **command) {
    if (responsible(getpid()) != getpid()) { fputs("Python ownership was not isolated.\n", stderr); return 126; }
    int queue = kqueue();
    if (queue < 0) return 126;
    // fd 4 is held only by the trusted caller. The calculation never inherits it.
    struct kevent change;
    EV_SET(&change, 4, EVFILT_READ, EV_ADD | EV_ENABLE, 0, 0, NULL);
    if (kevent(queue, &change, 1, NULL, 0, NULL) < 0) return 126;
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_addclose(&actions, 4);
    pid_t worker;
    int error = posix_spawn(&worker, command[0], &actions, NULL, command, environ);
    posix_spawn_file_actions_destroy(&actions);
    if (error) { fprintf(stderr, "Python worker: %s\n", strerror(error)); close(queue); return 126; }
    EV_SET(&change, worker, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT, 0, NULL);
    // ESRCH is possible for a very short calculation; waitpid below still obtains its result.
    kevent(queue, &change, 1, NULL, 0, NULL);
    int status = 0, ended = 0, abandoned = 0;
    while (!ended && !abandoned) {
        pid_t reaped = waitpid(worker, &status, WNOHANG);
        if (reaped == worker) { ended = 1; break; }
        struct kevent event;
        struct timespec timeout = {0, 50000000};
        int n = kevent(queue, NULL, 0, &event, 1, &timeout);
        if (n < 0 && errno != EINTR) { abandoned = 1; break; }
        if (n > 0 && event.filter == EVFILT_READ && (event.flags & EV_EOF)) abandoned = 1;
    }
    close(queue);
    // Keep the owner alive while removing all attributed descendants, including new sessions and orphaned grandchildren.
    int quiet = 0;
    for (int attempt = 0; attempt < 400 && quiet < 3; attempt++) {
        int left = sweep();
        if (left < 0) { fputs("Could not verify Python descendant cleanup.\n", stderr); return 126; }
        quiet = left == 0 ? quiet + 1 : 0;
        usleep(5000);
    }
    if (quiet < 3) { fputs("Python descendants did not stop.\n", stderr); return 126; }
    if (!ended || abandoned) return 125;
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

int main(int argc, char **argv) {
    if (argc > 1 && !strcmp(argv[1], "--sweep")) return best_effort(argc, argv);
    responsible = dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
    disclaim = dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
    if (!responsible || !disclaim || argc < 2) { fputs("Python process ownership is unavailable.\n", stderr); return 126; }
    if (!strcmp(argv[1], "--owner")) return argc > 2 ? own(&argv[2]) : 126;
    char **args = calloc((size_t)argc + 2, sizeof(char *));
    if (!args) return 126;
    args[0] = argv[0]; args[1] = "--owner";
    for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
    posix_spawnattr_t attr;
    posix_spawnattr_init(&attr);
    if (disclaim(&attr, 1)) return 126;
    posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP);
    posix_spawnattr_setpgroup(&attr, 0);
    pid_t owner;
    int error = posix_spawn(&owner, argv[0], NULL, &attr, args, environ);
    posix_spawnattr_destroy(&attr); free(args); close(4);
    if (error) { fprintf(stderr, "Python owner: %s\n", strerror(error)); return 126; }
    int status;
    while (waitpid(owner, &status, 0) < 0) if (errno != EINTR) return 126;
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
