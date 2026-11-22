// Prints a process's physical footprint in bytes (the number top's MEM and Activity Monitor's Memory show, including
// compressed pages) every <interval> milliseconds, one line each, for the calculation memory guard
// (pi-extensions/calculate.ts). It only reads that process's usage. It exits 0 once the process is gone or its output
// closes (the guard stopped listening), and 1 when the usage cannot be read.
// Usage: footprint <pid> <interval ms>
import Darwin

let args = CommandLine.arguments
guard args.count == 3, let pid = Int32(args[1]), pid > 0, let ms = UInt32(args[2]), (10...10_000).contains(ms) else {
  fputs("usage: footprint <pid> <interval ms 10-10000>\n", stderr); exit(64)
}
signal(SIGPIPE, SIG_IGN) // a closed pipe becomes a failed write below, not a crash
let parent = getppid()
while true {
  var info = rusage_info_v4()
  let status = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
  }
  if status != 0 { exit(errno == ESRCH ? 0 : 1) }
  if fputs("\(info.ri_phys_footprint)\n", stdout) < 0 || fflush(stdout) != 0 { exit(0) }
  if getppid() != parent { exit(0) } // the guard is gone
  usleep(ms * 1000)
}
