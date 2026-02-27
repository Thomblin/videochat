.PHONY: build run stop logs dev tidy clean import release test test-go test-js

# Load .env if present (for RSYNC_DEST)
-include .env
export

## build: build the Docker image
build:
	go build -o videochat .

## run: start the app in the background
run:
	./videochat

## release: cross-compile for Raspberry Pi (arm64) and rsync to RSYNC_DEST
release:
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-w -s" -o videochat .
	rsync -avz --progress \
		videochat \
		static \
		$(RSYNC_DEST)/

