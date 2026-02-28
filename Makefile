.PHONY: build run release test test-go test-js tidy clean

# Load .env if present (for RSYNC_DEST)
-include .env
export

## build: compile the Go binary
build:
	go build -o videochat ./service

## run: start the app
run:
	./videochat

## test: run all tests
test: test-go test-js

## test-go: run Go tests with race detector
test-go:
	go test -race -count=1 -timeout 60s -v ./service/...

## test-js: run frontend tests
test-js:
	cd www && npm test

## tidy: tidy Go modules and verify
tidy:
	go mod tidy
	go mod verify

## clean: remove build artifacts
clean:
	rm -f videochat cert.pem key.pem
	rm -rf www/node_modules

## release: cross-compile for Raspberry Pi (arm64) and rsync to RSYNC_DEST
release:
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-w -s" -o videochat ./service
	rsync -avz --progress \
		videochat \
		www \
		$(RSYNC_DEST)/
