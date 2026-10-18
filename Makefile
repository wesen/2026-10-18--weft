GO ?= GOWORK=off go
BIN ?= bin/weft

GLAZED_LINT_BIN ?= /tmp/glazed-lint
GLAZED_LINT_PKG ?= github.com/go-go-golems/glazed/cmd/tools/glazed-lint
GLAZED_VERSION ?= $(shell GOWORK=off go list -m -f '{{.Version}}' github.com/go-go-golems/glazed 2>/dev/null)
GLAZED_LINT_DIRS ?= ./cmd/... ./pkg/...

.PHONY: all web lab-deps build test js-test lint glazed-lint-build glazed-lint serve doctor

all: web build

# Weft Lab: install the page's build deps once, then bundle it into pkg/web/static/lab.html.
lab-deps:
	cd weft-lab/app && npm ci

web:
	$(GO) generate ./pkg/web

build:
	$(GO) build -o $(BIN) ./cmd/weft

test:
	$(GO) test ./... -count=1

# The Weft compiler/simulator's own test suite (node:test).
js-test:
	cd weft-lab/app && node --test test/*.test.mjs

lint: glazed-lint
	$(GO) vet ./...

glazed-lint-build:
	@if [ -n "$(GLAZED_VERSION)" ] && [ "$(GLAZED_VERSION)" != "(devel)" ]; then \
		GOBIN=$(dir $(GLAZED_LINT_BIN)) GOWORK=off go install $(GLAZED_LINT_PKG)@$(GLAZED_VERSION); \
	else \
		GOBIN=$(dir $(GLAZED_LINT_BIN)) GOWORK=off go install $(GLAZED_LINT_PKG); \
	fi

glazed-lint: glazed-lint-build
	GOWORK=off go vet -vettool=$(GLAZED_LINT_BIN) $(GLAZED_LINT_DIRS)

serve: build
	$(BIN) serve

doctor: build
	$(BIN) doctor
