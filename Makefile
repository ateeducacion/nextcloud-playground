PORT ?= 8085
NC_MAJOR ?= 33
NC_RELEASE ?= latest-33

.PHONY: help up deps prepare bundle bundle-all bundle-30 bundle-31 bundle-32 bundle-33 \
        serve test test-e2e lint format clean reset

help:
	@printf '%s\n' 'Nextcloud Playground Make targets:' '' \
	  '  make deps        Install npm dependencies' \
	  '  make prepare     Sync browser deps and build the worker bundle' \
	  '  make bundle      Build one Nextcloud bundle (default NC 33)' \
	  '  make bundle-all  Build NC 30, 31, 32 and 33 bundles' \
	  '  make serve       Start the local dev server' \
	  '  make up          Run bundle + serve' \
	  '  make test        Run unit tests' \
	  '  make test-e2e    Run Playwright browser tests' \
	  '  make lint        Run Biome linter' \
	  '  make format      Auto-fix lint and formatting issues' \
	  '  make clean       Remove generated caches and bundle artifacts' \
	  '  make reset       Alias of clean plus cache reset' '' \
	  'Common overrides:' \
	  '  PORT=9090 make serve' \
	  '  NC_MAJOR=32 NC_RELEASE=latest-32 make bundle'

deps:
	npm install

prepare: deps
	npm run sync-browser-deps
	npm run build-worker
	npm run prepare-runtime

bundle: prepare
	NC_MAJOR=$(NC_MAJOR) NC_RELEASE=$(NC_RELEASE) npm run bundle

bundle-30:
	NC_MAJOR=30 NC_RELEASE=latest-30 npm run bundle

bundle-31:
	NC_MAJOR=31 NC_RELEASE=latest-31 npm run bundle

bundle-32:
	NC_MAJOR=32 NC_RELEASE=latest-32 npm run bundle

bundle-33:
	NC_MAJOR=33 NC_RELEASE=latest-33 npm run bundle

bundle-all: prepare bundle-30 bundle-31 bundle-32 bundle-33

test:
	node --test tests/*.test.mjs

test-e2e:
	npm run test:e2e

lint:
	npx @biomejs/biome check

format:
	npx @biomejs/biome check --fix

serve:
	PORT=$(PORT) node ./scripts/dev-server.mjs

up: bundle serve

clean:
	rm -rf .cache
	rm -rf vendor
	rm -rf dist
	rm -rf assets/nextcloud/*
	rm -rf assets/manifests/*
	mkdir -p assets/nextcloud assets/manifests
	touch assets/nextcloud/.gitkeep assets/manifests/.gitkeep

reset: clean
	rm -rf .cache
