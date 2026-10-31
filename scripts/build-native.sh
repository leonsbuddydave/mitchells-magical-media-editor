#!/bin/sh
# Compiles the place lookup helper. Without it the app works, minus place lookups.
set -e
cd "$(dirname "$0")/.."
source_file=native/places.swift
binary=native/build/places
if [ -x "$binary" ] && [ "$binary" -nt "$source_file" ]; then exit 0; fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found: place lookups are off. Run xcode-select --install to enable them."
  exit 0
fi
mkdir -p native/build
swiftc -O "$source_file" -o "$binary" 2>/dev/null
