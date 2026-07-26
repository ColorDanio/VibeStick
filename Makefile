# Select the VibeConn implementation explicitly.  CI/release defaults to 1.
VIBECONN_IMPLEMENTATION ?= 1

.PHONY: vibeconn-build vibeconn-test vibeconn vibeconn-daemon

vibeconn-build:
	@if [ "$(VIBECONN_IMPLEMENTATION)" = "1" ]; then \
		python -m build host/; \
	elif [ "$(VIBECONN_IMPLEMENTATION)" = "2" ]; then \
		npm run build --prefix host-ts && npm run build --prefix host-ts/desktop; \
	else \
		echo "VIBECONN_IMPLEMENTATION must be 1 or 2" >&2; exit 2; \
	fi

vibeconn-test:
	@if [ "$(VIBECONN_IMPLEMENTATION)" = "1" ]; then \
		python -m pytest host/tests/ -q; \
	elif [ "$(VIBECONN_IMPLEMENTATION)" = "2" ]; then \
		npm test --prefix host-ts; \
	else \
		echo "VIBECONN_IMPLEMENTATION must be 1 or 2" >&2; exit 2; \
	fi

vibeconn:
	@VIBECONN_IMPLEMENTATION=$(VIBECONN_IMPLEMENTATION) tools/vibeconn

vibeconn-daemon:
	@VIBECONN_IMPLEMENTATION=$(VIBECONN_IMPLEMENTATION) tools/vibeconn --daemon
