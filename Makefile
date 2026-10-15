# Convenience wrappers around meson/ninja.
#
#   make build     configure (if needed) and compile the extension
#   make install   install into the (local) extension directory
#   make pack      create a zip file ready for extensions.gnome.org
#   make check     run the test suite
#   make clean     remove the compiled artifacts
#   make distclean remove the build directories and the zip file

UUID := $(shell jq -r '.uuid' metadata.json)
VERSION := $(shell sed -n "s/^[[:space:]]*version[[:space:]]*:[[:space:]]*'\([^']*\)'.*/\1/p" meson.build | head -n 1)

BUILD_DIR ?= _build
PACK_BUILD_DIR ?= $(BUILD_DIR)-pack
ZIP ?= $(UUID).zip

MESON ?= meson
NINJA ?= ninja

.PHONY: all setup build install pack zip check clean distclean help

all: build

setup: $(BUILD_DIR)/build.ninja

$(BUILD_DIR)/build.ninja: meson.build metadata.json
	$(MESON) setup $(BUILD_DIR)

build: setup
	$(MESON) compile -C $(BUILD_DIR)

install: build
	$(MESON) install -C $(BUILD_DIR)

# The "zip-file" run target only exists for local installations, so packaging
# always uses a dedicated build directory instead of the one used to install.
pack zip: $(PACK_BUILD_DIR)/build.ninja
	$(NINJA) -C $(PACK_BUILD_DIR) zip-file
	cp -f '$(PACK_BUILD_DIR)/$(UUID).zip' '$(ZIP)'
	@echo "Packaged version $(VERSION) as $(ZIP)"

$(PACK_BUILD_DIR)/build.ninja: meson.build metadata.json
	$(MESON) setup $(PACK_BUILD_DIR) -Dlocal_install=enabled

check: setup
	$(MESON) test -C $(BUILD_DIR) --print-errorlogs

clean:
	@for dir in '$(BUILD_DIR)' '$(PACK_BUILD_DIR)'; do \
	    if [ -f "$$dir/build.ninja" ]; then $(NINJA) -C "$$dir" clean; fi; \
	done

distclean:
	rm -rf '$(BUILD_DIR)' '$(PACK_BUILD_DIR)'
	rm -f '$(ZIP)'

help:
	@echo "Targets: build install pack check clean distclean"
	@echo "Variables: BUILD_DIR=$(BUILD_DIR) PACK_BUILD_DIR=$(PACK_BUILD_DIR) ZIP=$(ZIP)"
