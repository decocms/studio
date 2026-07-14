/** Signal name → number, shell `kill -l` convention. Used to map a
 *  signal-terminated child to its `128 + signal` exit code. */
export const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};
