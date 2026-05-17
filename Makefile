.PHONY: local pi4 pi5 build check down logs
COMPOSE_ENV_FILES = --env-file .env --env-file .localenv $(if $(ENV_FILE),--env-file $(ENV_FILE),)
# Usage: make local CONTAINER=yt-db or make up to start all containers
local:
	docker compose --env-file .env --env-file .localenv up -d --build $(CONTAINER)

pi5:
	docker compose --env-file .env --env-file .pi5env up -d --build $(CONTAINER)

pi4:
	docker compose --env-file .env --env-file .pi4env up -d --build $(CONTAINER)	

# You can specify which env file to use when building, for example: make build ENV_FILE=.pi5env
build:
	docker compose $(COMPOSE_ENV_FILES) build --no-cache

check:
	docker compose $(COMPOSE_ENV_FILES) config

down:
	docker compose $(COMPOSE_ENV_FILES) down

logs:
	docker compose $(COMPOSE_ENV_FILES) logs -f
