#!/bin/sh
# Builds wasm/mp3 (rusty_mp3, Apache-2.0) to src/vendor/mp3-wasm.ts. Needs Rust 1.100.0 with the
# wasm32-unknown-unknown target and binaryen 133 (wasm-opt): Omnitext's F-Droid build rebuilds this
# file with those pins and expects the same bytes.
set -e
cd "$(dirname "$0")/../wasm/mp3"
# No local paths in the binary: panic messages keep source paths, so map them to neutral ones.
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$(cd ../.. && pwd)=/build/scoredit --remap-path-prefix=$CARGO_HOME=/cargo"
cargo build --release --locked --target wasm32-unknown-unknown
wasm-opt -O3 target/wasm32-unknown-unknown/release/scoredit_mp3.wasm -o target/mp3.wasm
cd ../..
sh scripts/embed-mp3-wasm.sh wasm/mp3/target/mp3.wasm
