#!/usr/bin/env bash
# Gradi samostalne izvršne datoteke s ugrađenom igrom u dist/.
set -euo pipefail
cd "$(dirname "$0")/.."
npm test
go vet . && GOOS=windows go vet .
mkdir -p dist
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o dist/potapanje-brodova.exe .
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o dist/potapanje-brodova-linux .
ls -lh dist/
