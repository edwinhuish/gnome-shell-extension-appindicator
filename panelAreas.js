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

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {InputSourceIndicator} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

import * as SettingsManager from './settingsManager.js';
import * as Util from './util.js';

export const LANGUAGE_AREA_ROLE = 'appindicator-language-area';

const SHELL_LANGUAGE_AREA_ROLE = 'keyboard';
const PANEL_BOX_NAMES = ['left', 'center', 'right'];

let panelAreas;

/**
 * Owns the panel areas that belong to this extension:
 *
 *     [ language area ][ tray area ]
 *
 * The language area holds the language (input source) indicator and is always
 * kept as the leftmost item of the panel box we manage, so that it can never be
 * pushed around by the tray icons (or by anything else) that show up later.
 *
 * The tray area is the place where the tray icons are added, right after the
 * language area (see addIconToPanel() in indicatorStatusIcon.js).
 */
export class PanelAreas extends Signals.EventEmitter {
    static initialize() {
        panelAreas ??= new PanelAreas();
        return panelAreas;
    }

    static destroy() {
        panelAreas?.destroy();
        panelAreas = null;
    }

    static getDefault() {
        return panelAreas;
    }

    constructor() {
        super();

        if (panelAreas)
            throw new Error('PanelAreas is already constructed');

        const settings = SettingsManager.getDefaultGSettings();

        this._adoptedLanguageIndicator = null;
        this._ownLanguageIndicator = null;

        Util.connectSmart(settings, 'changed::tray-pos', this, () => this.relayout());
        Util.connectSmart(settings, 'changed::language-area-enabled', this,
            () => this.relayout());

        Util.connectSmart(Main.sessionMode, 'updated', this, () => this.relayout());

        this.relayout();
    }

    /**
     * The panel box (`left`, `center` or `right`) the extension areas live in.
     */
    get boxName() {
        const boxName = SettingsManager.getDefaultGSettings().get_string('tray-pos');
        return PANEL_BOX_NAMES.includes(boxName) ? boxName : 'right';
    }

    /**
     * The indicator that currently plays the language area role, if any.
     */
    get languageArea() {
        return this._adoptedLanguageIndicator ?? this._ownLanguageIndicator;
    }

    /**
     * Re-applies the position of every area we own.
     */
    relayout() {
        if (!Main.panel)
            return;

        if (!SettingsManager.getDefaultGSettings().get_boolean('language-area-enabled')) {
            this._releaseLanguageArea();
            return;
        }

        const indicator = this._getLanguageIndicator();
        if (indicator)
            this._moveToBox(indicator.container, this._getBox(), 0);
    }

    _getBox(boxName = this.boxName) {
        const boxes = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox,
        };

        return boxes[boxName] ?? Main.panel._rightBox;
    }

    _getLanguageIndicator() {
        // The shell provides the input source indicator, which is what the
        // language area is about, so we adopt it rather than showing a second
        // language indicator next to it.
        const shellIndicator = Main.panel.statusArea[SHELL_LANGUAGE_AREA_ROLE];

        if (shellIndicator) {
            if (this._ownLanguageIndicator) {
                Main.panel.statusArea[LANGUAGE_AREA_ROLE] = null;
                this._ownLanguageIndicator.destroy();
                this._ownLanguageIndicator = null;
            }

            this._adoptedLanguageIndicator = shellIndicator;
            return shellIndicator;
        }

        // Some session modes don't have an input source indicator in the panel
        // at all, in that case we provide the language area ourselves.
        if (!this._ownLanguageIndicator) {
            try {
                this._ownLanguageIndicator = new InputSourceIndicator();
                Main.panel.addToStatusArea(LANGUAGE_AREA_ROLE, this._ownLanguageIndicator,
                    0, this.boxName);
            } catch (e) {
                this._ownLanguageIndicator = null;
                Util.Logger.warn(`Failed to create the language area: ${e}`);
            }
        }

        return this._ownLanguageIndicator;
    }

    _releaseLanguageArea() {
        const adopted = this._adoptedLanguageIndicator;
        if (adopted) {
            // Hand the indicator back to the shell's session mode layout.
            for (const boxName of PANEL_BOX_NAMES) {
                const roles = Main.sessionMode.panel[boxName] ?? [];
                const index = roles.indexOf(SHELL_LANGUAGE_AREA_ROLE);

                if (index >= 0) {
                    this._moveToBox(adopted.container, this._getBox(boxName), index);
                    break;
                }
            }

            this._adoptedLanguageIndicator = null;
        }

        if (this._ownLanguageIndicator) {
            Main.panel.statusArea[LANGUAGE_AREA_ROLE] = null;
            this._ownLanguageIndicator.destroy();
            this._ownLanguageIndicator = null;
        }
    }

    /**
     * Moves an actor to `index` of `box`, no matter where it currently is.
     *
     * @param {Clutter.Actor} actor the actor to move.
     * @param {St.BoxLayout} box the panel box it should end up in.
     * @param {number} index the index it should have in that box.
     */
    _moveToBox(actor, box, index) {
        const parent = actor.get_parent();

        if (parent === box) {
            box.set_child_at_index(actor, Math.min(index, box.get_n_children() - 1));
            return;
        }

        if (parent)
            parent.remove_child(actor);

        box.insert_child_at_index(actor, Math.min(index, box.get_n_children()));
    }

    destroy() {
        this._releaseLanguageArea();

        // connectSmart() drops every connection we made once we emit this.
        this.emit('destroy');
        delete this._settingsIds;
    }
}
