all:
	$(MAKE) -C wat
	$(MAKE) -C rust
	$(MAKE) -C doom
	mkdir -p ./public
	cp -r ./wat ./public/
	cp -r ./rust ./public/
	# doom is a bit bigger, so we only copy the final artifacts.
	mkdir -p ./public/doom
	cp -a ./doom/index.html ./public/doom/
	cp -a ./doom/main.js ./public/doom/
	cp -a ./doom/doom.wasm ./public/doom/

dev:
	@command -v inotifywait >/dev/null 2>&1 || { echo "inotifywait not found. Install with: sudo apt install inotify-tools"; exit 1; }
	@echo "Watching for changes... (Ctrl+C to stop)"
	$(MAKE) all
	@while inotifywait -r -q -e modify,create,delete,move \
		--exclude '(target|public|\.git)' \
		wat rust doom; do \
		echo "Change detected, rebuilding..."; \
		$(MAKE) all; \
	done

clean:
	$(MAKE) -C wat clean
	$(MAKE) -C rust clean
	$(MAKE) -C doom clean
	rm -rf ./public

