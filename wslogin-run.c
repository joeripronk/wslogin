/*
 * wslogin-run: minimal setuid helper to start a session process as a
 * normal user from the unprivileged wslogin service user.
 *
 * node-pty attaches its direct child to the terminal, and the tmux
 * client must run as the session user (the tmux socket is mode 0600,
 * only its owner may connect). Only root can become another user, so
 * this helper is setuid root: it drops to the target user and execs
 * the command, as a single process, without the extra forked sudo
 * parent sudo(8) leaves in the process list for the whole view.
 *
 * Restrictions:
 *   - the real caller (uid) must be the service user, compiled in as
 *     WSLOGIN_RUN_CALLER (default "wslogin"); the environment is never
 *     consulted, the caller cannot influence this check
 *   - root (uid or gid 0) is refused as target
 *   - supplementary groups are reinitialized for the target
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <unistd.h>
#include <pwd.h>
#include <grp.h>

#ifndef WSLOGIN_RUN_CALLER
#define WSLOGIN_RUN_CALLER "wslogin"
#endif

int main(int argc, char *argv[])
{
	struct passwd *pw, *cp;

	if (argc < 3) {
		fprintf(stderr, "usage: wslogin-run <user> <command> [arguments ...]\n");
		return 2;
	}

	if (geteuid() != 0) {
		fprintf(stderr, "wslogin-run: must be setuid root\n");
		return 1;
	}
	if (getuid() != 0) {
		cp = getpwnam(WSLOGIN_RUN_CALLER);
		if (cp == NULL || cp->pw_uid != getuid()) {
			fprintf(stderr, "wslogin-run: caller uid %u is not %s\n",
				getuid(), WSLOGIN_RUN_CALLER);
			return 1;
		}
	}

	pw = getpwnam(argv[1]);
	if (pw == NULL) {
		fprintf(stderr, "wslogin-run: no passwd entry for %s\n", argv[1]);
		return 1;
	}
	if (pw->pw_uid == 0 || pw->pw_gid == 0) {
		fprintf(stderr, "wslogin-run: refusing to run as root\n");
		return 1;
	}

	if (setgroups(0, NULL) != 0) {
		perror("wslogin-run: setgroups");
		return 1;
	}
	if (initgroups(argv[1], pw->pw_gid) != 0) {
		perror("wslogin-run: initgroups");
		return 1;
	}
	if (setgid(pw->pw_gid) != 0) {
		perror("wslogin-run: setgid");
		return 1;
	}
	if (setuid(pw->pw_uid) != 0) {
		perror("wslogin-run: setuid");
		return 1;
	}

	execvp(argv[2], &argv[2]);
	perror("wslogin-run: execvp");
	return 127;
}
