.PHONY: local remote build-local build-remote check-local check-remote down-local down-remote logs-local logs-remote

local:
	docker compose --env-file .env --env-file .localenv up -d --build

remote:
	docker compose --env-file .env --env-file .remotenv up -d --build

build-local:
	docker compose --env-file .env --env-file .localenv build --no-cache

build-remote:
	docker compose --env-file .env --env-file .remotenv build --no-cache

check-local:
	docker compose --env-file .env --env-file .localenv config

check-remote:
	docker compose --env-file .env --env-file .remotenv config

down-local:
	docker compose --env-file .env --env-file .localenv down

down-remote:
	docker compose --env-file .env --env-file .remotenv down

logs-local:
	docker compose --env-file .env --env-file .localenv logs -f

logs-remote:
	docker compose --env-file .env --env-file .remotenv logs -f
