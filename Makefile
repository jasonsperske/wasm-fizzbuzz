all:
	$(MAKE) -C wat
	$(MAKE) -C rust
	$(MAKE) -C doom
	mkdir -p ./public
	cp -r ./wat ./public/
	cp -r ./rust ./public/
	cp -a ./maze.svg ./public/
	# doom is a bit bigger, so we only copy the final artifacts.
	mkdir -p ./public/doom
	cp -a ./doom/index.html ./public/doom/
	cp -a ./doom/main.js ./public/doom/
	cp -a ./doom/doom.wasm ./public/doom/
	cp -a ./doom/soundfont.sf2 ./public/doom/
	# for each *.json file in doom/, copy it to public/doom/ and also copy index.html to a subfolder named after the json file (without extension)
	# for each entry in .doors, copy index.html to a file named after the key
	for json in ./doom/*.json; do \
		json_name=$$(basename "$$json" .json); \
		mkdir -p ./public/doom/"$$json_name"; \
		cp -a "$$json" ./public/doom/; \
		cp -a ./doom/index.html ./public/doom/"$$json_name"/; \
		for door in $$(jq -r '.doors | keys[]' < "$$json"); do \
			cp -a ./doom/index.html ./public/doom/"$$json_name"/"$$door".html; \
		done; \
	done

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

