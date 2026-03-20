.PHONY: up up-remote build check down logs
# Usage: make up CONTAINER=yt-db or make up to start all containers
up:
	docker compose --env-file .env --env-file .localenv up -d --build $(CONTAINER)

up-remote:
	docker compose --env-file .env --env-file .remotenv up -d --build $(CONTAINER)

build:
	docker compose --env-file .env --env-file .localenv build --no-cache

check:
	docker compose --env-file .env --env-file .localenv config

down:
	docker compose --env-file .env --env-file .localenv down

logs:
	docker compose --env-file .env --env-file .localenv logs -f
