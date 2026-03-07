.PHONY: local remote check-local check-remote down logs

local:
	docker compose --env-file .env --env-file .localenv up -d

remote:
	docker compose --env-file .env --env-file .remotenv up -d

check-local:
	docker compose --env-file .env --env-file .localenv config

check-remote:
	docker compose --env-file .env --env-file .remotenv config

down:
	docker compose down

logs:
	docker compose logs -f
