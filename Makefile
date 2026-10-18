# Convenience targets. Everything here is a thin wrapper around pnpm or
# docker compose - nothing is hidden behind make.

SHELL := /bin/sh
COMPOSE := docker compose

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ───────────────────────────── local development ─────────────────────────────

.PHONY: setup
setup: ## Install dependencies and build the shared package
	pnpm install
	pnpm build:shared

.PHONY: dev
dev: ## Run both APIs and the web app with reload
	pnpm dev

.PHONY: migrate
migrate: ## Apply pending SQL migrations
	pnpm migrate

.PHONY: seed
seed: ## Insert sample records (refuses to run in production)
	pnpm seed

.PHONY: import
import: ## Load a Discord forum scrape: make import FILE=scrape.jsonl [IMAGES=1] [DRY=1]
	@test -n "$(FILE)" || { echo "usage: make import FILE=path/to/scrape.jsonl [IMAGES=1] [DRY=1]"; exit 1; }
	@# The script runs with apps/api as its cwd, so a relative FILE has to be
	@# resolved here rather than passed through as-is.
	pnpm import:forum "$$(cd "$$(dirname "$(FILE)")" && pwd)/$$(basename "$(FILE)")" \
	  $(if $(CONFLICT),--conflict $(CONFLICT),) \
	  $(if $(LIMIT),--limit $(LIMIT),) \
	  $(if $(IMAGES),--images,) \
	  $(if $(DRY),--dry-run,)

.PHONY: apikey
apikey: ## Mint a scraper key: make apikey NAME="nightly" SCOPES=ingress:write
	pnpm apikey "$(NAME)" "$(SCOPES)"

.PHONY: check
check: ## Typecheck every package
	pnpm typecheck

# ───────────────────────────── homeserver stack ─────────────────────────────

.PHONY: up
up: ## Build and start everything except the tunnels
	$(COMPOSE) up -d --build

.PHONY: up-tunnels
up-tunnels: ## Start the stack including the two cloudflared tunnels
	$(COMPOSE) --profile tunnels up -d --build

.PHONY: down
down: ## Stop the stack (volumes are preserved)
	$(COMPOSE) down

.PHONY: logs
logs: ## Tail logs from every service
	$(COMPOSE) logs -f --tail=100

.PHONY: ps
ps: ## Show container status
	$(COMPOSE) ps

.PHONY: restart-api
restart-api: ## Rebuild and restart just the two API services
	$(COMPOSE) up -d --build api-text api-images

.PHONY: ingest
ingest: ## Import a scrape via the running stack: make ingest FILE=scrape.jsonl [IMAGES=1] [DRY=1]
	@test -n "$(FILE)" || { echo "usage: make ingest FILE=path/to/scrape.jsonl [IMAGES=1] [DRY=1] [CONFLICT=merge|skip|replace] [LIMIT=n]"; exit 1; }
	@test -f "$(FILE)" || { echo "no such file: $(FILE)"; exit 1; }
	@# Unlike `make import`, this needs no node on the host: the compiled script
	@# already lives in the api image. The scrape is bind-mounted read-only
	@# rather than copied, so a 2GB export costs nothing to hand over.
	@# Runs on api-images, not api-text: IMAGES=1 writes converted WebP into
	@# the storage volume, which api-text mounts read-only by design.
	$(COMPOSE) run --rm --no-deps 	  -v "$$(cd "$$(dirname "$(FILE)")" && pwd)/$$(basename "$(FILE)")":/tmp/scrape.jsonl:ro 	  api-images node dist/scripts/import-forum-scrape.js /tmp/scrape.jsonl 	  $(if $(CONFLICT),--conflict $(CONFLICT),) 	  $(if $(LIMIT),--limit $(LIMIT),) 	  $(if $(IMAGES),--images,) 	  $(if $(DRY),--dry-run,)

.PHONY: stack-apikey
stack-apikey: ## Mint a key via the running stack: make stack-apikey NAME="nightly" SCOPES=ingress:write
	$(COMPOSE) run --rm --no-deps api-text 	  node dist/scripts/create-api-key.js "$(NAME)" "$(SCOPES)"

.PHONY: psql
psql: ## Open a psql shell on the archive database
	$(COMPOSE) exec postgres psql -U $${POSTGRES_USER:-archive} -d $${POSTGRES_DB:-archive}

.PHONY: backup
backup: ## Dump the database to ./backups/
	@mkdir -p backups
	$(COMPOSE) exec -T postgres pg_dump -U $${POSTGRES_USER:-archive} -d $${POSTGRES_DB:-archive} \
	  --format=custom > backups/archive-$$(date +%Y%m%d-%H%M%S).dump
	@echo "wrote backups/archive-$$(date +%Y%m%d-%H%M%S).dump"

.PHONY: secrets
secrets: ## Print fresh values for the three secrets in .env
	@echo "SESSION_SECRET=$$(openssl rand -hex 32)"
	@echo "INGRESS_HMAC_SECRET=$$(openssl rand -hex 32)"
	@echo "INTERNAL_TOKEN=$$(openssl rand -hex 32)"
