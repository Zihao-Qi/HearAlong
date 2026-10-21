/** The pinned Python environment for run_python, shared by the extension and the server's startup warm-up. */
export const PACKAGES = ['numpy==2.2.6', 'scipy==1.15.3', 'sympy==1.14.0'];
export const UV_ARGS = ['run', '--no-project', '--quiet', '--python', '3.12', ...PACKAGES.flatMap(p => ['--with', p])];
