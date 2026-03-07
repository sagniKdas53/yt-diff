.PHONY: local remote check-local check-remote down-local down-remote logs-local logs-remote

local:
	docker compose --env-file .env --env-file .localenv up -d

remote:
	docker compose --env-file .env --env-file .remotenv up -d

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
