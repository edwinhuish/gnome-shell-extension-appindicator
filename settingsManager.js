// This file is part of the AppIndicator/KStatusNotifierItem GNOME Shell extension
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.

import {Logger} from './logger.js';

/**
 * Every settings key the extension reads, next to the schema that defines them.
 *
 * A schema that is older than the code (an install that copied the JavaScript
 * but left an old `gschemas.compiled` behind, which is what happens when the
 * schemas are not compiled again) does not fail in one place: the reads throw
 * wherever they are, which is somewhere inside the panel code, after half of
 * the extension is already built. The extension then stays enabled while doing
 * nothing, and the only visible symptom is that nothing happens at all.
 *
 * Reading the keys once at startup turns that into a single message that names
 * what is missing and what to do about it.
 *
 * Keep in sync with schemas/org.gnome.shell.extensions.appindicator.gschema.xml.
 */
const REQUIRED_KEYS = [
    'custom-icons',
    'hidden-icons',
    'hidden-legacy-icons',
    'icon-brightness',
    'icon-contrast',
    'icon-opacity',
    'icon-order',
    'icon-saturation',
    'icon-size',
    'known-icons',
    'language-area-enabled',
    'language-area-role',
    'legacy-tray-enabled',
    'panel-background-color',
    'panel-background-mode',
    'panel-background-opacity',
    'tray-icon-spacing',
    'tray-pos',
];

let settingsManager;

export class SettingsManager {
    static initialize(extension) {
        SettingsManager._settingsManager = new SettingsManager(extension);
    }

    static destroy() {
        SettingsManager._settingsManager.destroy();
        SettingsManager._settingsManager = null;
    }

    static getDefault() {
        return this._settingsManager;
    }

    get gsettings() {
        return this._gsettings;
    }

    constructor(extension) {
        if (settingsManager)
            throw new Error('SettingsManager is already constructed');

        this._gsettings = extension.getSettings();
        this._checkSchema();
    }

    destroy() {
        this._gsettings = null;
    }

    /**
     * Tells the user when the compiled schema is not the one the code was
     * written against, see REQUIRED_KEYS.
     *
     * The message is a warning rather than an error: GLib aborts the process
     * on a message of the ERROR level, and that process is the shell.
     */
    _checkSchema() {
        if (typeof this._gsettings.list_keys !== 'function')
            return;

        const available = new Set(this._gsettings.list_keys());
        const missing = REQUIRED_KEYS.filter(key => !available.has(key));

        if (!missing.length) {
            Logger.debug(`Settings schema is complete (${available.size} keys)`);
            return;
        }

        Logger.warn('The settings schema is out of date, it has no ' +
            `${missing.join(', ')}. Reinstall the extension and make sure that ` +
            'its schemas/gschemas.compiled is compiled again: ' +
            'glib-compile-schemas <extension-dir>/schemas');
    }
}

export function getDefault() {
    return SettingsManager.getDefault();
}

export function getDefaultGSettings() {
    return SettingsManager.getDefault().gsettings;
}
