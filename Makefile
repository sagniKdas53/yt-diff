.PHONY: env local pi4 pi5 build check down logs

TARGET ?= local
TARGET_ENV = envs/$(TARGET).env
GENERATED_ENV = .env
REQUIRED_ENV_VARS = DB_LOCATION HOSTNAME LOG_LEVELS HOST_SAVE_PATH DB_BACKUP_LOCATION HOST_COOKIES_FILE

env:
	@test -f envs/base.env || { echo "Missing envs/base.env"; exit 1; }
	@test -f $(TARGET_ENV) || { echo "Missing $(TARGET_ENV)"; exit 1; }
	@awk -F= ' \
		!/^[[:space:]]*#/ && NF >= 2 { \
			key = $$1; \
			sub(/^[[:space:]]+/, "", key); \
			sub(/[[:space:]]+$$/, "", key); \
			if (!(key in seen)) order[++count] = key; \
			seen[key] = 1; \
			line[key] = $$0; \
			next; \
		} \
		{ extra[++extra_count] = $$0 } \
		END { \
			for (i = 1; i <= extra_count; i++) if (extra[i] == "") print extra[i]; \
			for (i = 1; i <= count; i++) print line[order[i]]; \
		} \
	' envs/base.env $(TARGET_ENV) > $(GENERATED_ENV)
	@for var in $(REQUIRED_ENV_VARS); do \
		grep -q "^$$var=" $(GENERATED_ENV) || { echo "Missing required env var: $$var"; rm -f $(GENERATED_ENV); exit 1; }; \
	done
	@docker compose config >/dev/null || { echo "Generated .env is invalid"; rm -f $(GENERATED_ENV); exit 1; }
	@echo "Generated $(GENERATED_ENV) from envs/base.env + $(TARGET_ENV)"

local:
	@$(MAKE) env TARGET=local

pi5:
	@$(MAKE) env TARGET=pi5

pi4:
	@$(MAKE) env TARGET=pi4

build:
	docker compose build --no-cache

check:
	docker compose config

down:
	docker compose down

logs:
	docker compose logs -f
