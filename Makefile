# Soldat TS — fresh-clone driver. `make` lists targets.
SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help setup up down status test league train evolve fight \
	autopilot-install autopilot-uninstall autopilot-status

LIVE     := arena-live
PLAY_LOG := /tmp/soldat-play.log
GAME_URL := http://localhost:5173
TICK_URL := http://localhost:8901

help: ## list targets
	@grep -hE '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-8s %s\n", $$1, $$2}'

setup: ## install deps (pnpm; pins in .tool-versions)
	@command -v node >/dev/null || { echo "node missing — prereqs (.tool-versions):"; cat .tool-versions; exit 1; }
	@command -v pnpm >/dev/null || { echo "pnpm missing — prereqs (.tool-versions):"; cat .tool-versions; exit 1; }
	pnpm install

up: ## start game client + watcher + commissioner + league grinder, detached
	@curl -sfo /dev/null $(GAME_URL) && echo "client: already up" || \
		{ nohup pnpm play > $(PLAY_LOG) 2>&1 & echo "client: starting (log $(PLAY_LOG))"; }
	@pgrep -f "node watch.mjs" >/dev/null && echo "watcher: already up" || \
		{ cd $(LIVE) && nohup node watch.mjs > watcher.log 2>&1 & echo "watcher: starting (log $(LIVE)/watcher.log)"; }
	@pgrep -f "node commissioner.mjs" >/dev/null && echo "commissioner: already up" || \
		{ cd $(LIVE) && nohup node commissioner.mjs > commissioner.log 2>&1 & echo "commissioner: starting (log $(LIVE)/commissioner.log)"; }
	@pgrep -f "node league.mjs" >/dev/null && echo "grinder: already up" || \
		{ cd $(LIVE) && nohup node league.mjs > league.log 2>&1 & echo "grinder: starting (log $(LIVE)/league.log)"; }
	@for i in $$(seq 1 30); do \
		curl -sfo /dev/null $(GAME_URL) && curl -sfo /dev/null $(TICK_URL) && break; sleep 1; done; \
	curl -sfo /dev/null $(GAME_URL) || { echo "TIMEOUT: no game on :5173 — see $(PLAY_LOG)"; exit 1; }; \
	curl -sfo /dev/null $(TICK_URL) || { echo "TIMEOUT: no ticker on :8901 — see $(LIVE)/watcher.log"; exit 1; }; \
	echo "game/menu : $(GAME_URL)"; \
	echo "ticker    : $(TICK_URL)"; \
	echo "board json: $(TICK_URL)/data.json"

down: ## stop client, watcher, commissioner, grinder
	@pkill -f "node commissioner.mjs" 2>/dev/null && echo "commissioner: stopped" || echo "commissioner: not running"
	@pkill -f "node league.mjs" 2>/dev/null && echo "grinder: stopped" || echo "grinder: not running"
	@pkill -f "node watch.mjs" 2>/dev/null && echo "watcher: stopped" || echo "watcher: not running"
	@kill $$(lsof -ti :5173) 2>/dev/null && echo "client: stopped" || echo "client: not running"

status: ## pgrep + curl each service
	@printf "%-13s %-6s %s\n" SERVICE STATE WHERE
	@curl -sfo /dev/null $(GAME_URL) && printf "%-13s %-6s %s\n" client up "$(GAME_URL)" \
		|| printf "%-13s %-6s %s\n" client DOWN "$(PLAY_LOG)"
	@pgrep -f "node watch.mjs" >/dev/null && curl -sfo /dev/null $(TICK_URL) \
		&& printf "%-13s %-6s %s\n" watcher up "$(TICK_URL)" \
		|| printf "%-13s %-6s %s\n" watcher DOWN "$(LIVE)/watcher.log"
	@pgrep -f "node commissioner.mjs" >/dev/null \
		&& printf "%-13s %-6s %s\n" commissioner up "pid $$(pgrep -f 'node commissioner.mjs' | head -1)" \
		|| printf "%-13s %-6s %s\n" commissioner DOWN "$(LIVE)/commissioner.log"
	@pgrep -f "node league.mjs" >/dev/null \
		&& printf "%-13s %-6s %s\n" grinder up "pid $$(pgrep -f 'node league.mjs' | head -1)" \
		|| printf "%-13s %-6s %s\n" grinder DOWN "$(LIVE)/league.log"

test: ## typecheck + unit suite
	pnpm typecheck && pnpm vitest run

grind: ## start just the league grinder daemon (~120 matches/hr)
	@pgrep -f "node league.mjs" >/dev/null && echo "grinder: already up" || \
		{ cd $(LIVE) && nohup node league.mjs > league.log 2>&1 & echo "grinder: starting"; }

league: ## full roster round-robin
	pnpm arena

train: ## imitation training from datasets
	node tools/train-imitation.mjs

evolve: ## evolutionary tuning (60 gens, 8 jobs)
	node tools/evolve.mjs --generations 60 --jobs 8

offload: ## move >24h replay blobs to the bucket (verified), free the disk
	node tools/offload-replays.mjs

fight: ## make fight A=fights/x.json B=fights/y.json [ARENA=n]
	@test -n "$(A)" && test -n "$(B)" || { echo "usage: make fight A=fights/x.json B=fights/y.json [ARENA=n]"; exit 1; }
	pnpm arena fight $(A) $(B) --matches 3 $(if $(ARENA),--arena $(ARENA),)

# --- THE AUTOPILOT (goal 428): boot-persistent keeper, gated by the config ----
# The launchd job stays loaded forever; the real on/off switch is `enabled`
# in arena-live/autopilot.json — http://localhost:8901/config.html.
AP_PLIST := $(HOME)/Library/LaunchAgents/com.soldat.autopilot.plist

autopilot-install: ## install + start the boot-time autopilot (launchd)
	cp deploy/com.soldat.autopilot.plist $(AP_PLIST)
	@launchctl bootout gui/$$(id -u)/com.soldat.autopilot 2>/dev/null || true
	launchctl bootstrap gui/$$(id -u) $(AP_PLIST)
	@echo "autopilot installed + running at boot — toggle it: http://localhost:8901/config.html"

autopilot-uninstall: ## stop + remove the boot-time autopilot
	@launchctl bootout gui/$$(id -u)/com.soldat.autopilot 2>/dev/null || true
	rm -f $(AP_PLIST)
	@echo "autopilot uninstalled (daemons it started keep running — 'make down' stops them)"

autopilot-status: ## launchd state + keeper log tail
	@launchctl print gui/$$(id -u)/com.soldat.autopilot 2>/dev/null \
		| grep -E "state|pid|last exit" || echo "autopilot: NOT LOADED (make autopilot-install)"
	@echo "--- tools/autopilot.log (last 5) ---"
	@tail -5 tools/autopilot.log 2>/dev/null || echo "(no log yet)"
