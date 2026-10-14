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

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {InputSourceIndicator} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

import * as SettingsManager from './settingsManager.js';
import * as Util from './util.js';

export const LANGUAGE_AREA_ROLE = 'appindicator-language-area';
export const FOLD_BUTTON_ROLE = 'appindicator-fold-button';

const SHELL_LANGUAGE_AREA_ROLE = 'keyboard';
const PANEL_BOX_NAMES = ['left', 'center', 'right'];

let panelAreas;

/**
 * The button that sits between the language area and the tray area and reveals
 * the icons the user has hidden.
 */
export const TrayFoldButton = GObject.registerClass(
class AppIndicatorTrayFoldButton extends PanelMenu.Button {
    static get HIDDEN_ICON() {
        return 'pan-end-symbolic';
    }

    static get REVEALED_ICON() {
        return 'pan-start-symbolic';
    }

    _init() {
        // No menu: clicking this button only reveals the hidden tray icons.
        super._init(0.5, 'Hidden tray icons', true);

        this.add_style_class_name('appindicator-fold-button');

        this._foldIcon = new St.Icon({
            style_class: 'system-status-icon',
            icon_name: TrayFoldButton.HIDDEN_ICON,
        });
        this.add_child(this._foldIcon);

        this._foldGesture = new Clutter.ClickGesture();
        this._foldGesture.set_recognize_on_press(true);
        this._foldGesture.connect('recognize',
            () => PanelAreas.getDefault()?.toggleHiddenIcons());
        this.add_action(this._foldGesture);
    }

    setRevealed(revealed) {
        this._foldIcon.icon_name = revealed
            ? TrayFoldButton.REVEALED_ICON : TrayFoldButton.HIDDEN_ICON;
    }
});

/**
 * Owns the panel areas that belong to this extension:
 *
 *     [ language area ][ fold button ][ tray area ]
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
        this._foldButton = null;
        this._trayIcons = new Set();
        this._hiddenIcons = new Set();
        this._hiddenIconsRevealed = false;

        Util.connectSmart(settings, 'changed::tray-pos', this, () => this.relayout());
        Util.connectSmart(settings, 'changed::language-area-enabled', this,
            () => this.relayout());
        Util.connectSmart(settings, 'changed::hidden-icons', this,
            () => this._updateHiddenIcons());

        Util.connectSmart(Main.sessionMode, 'updated', this, () => this.relayout());

        this._updateHiddenIcons();
        this.relayout();
    }

    /**
     * The panel box (`left`, `center` or `right`) the extension areas live in.
     */
    get boxName() {
        const boxName = this._getSettings().get_string('tray-pos');
        return PANEL_BOX_NAMES.includes(boxName) ? boxName : 'right';
    }

    /**
     * The indicator that currently plays the language area role, if any.
     */
    get languageArea() {
        return this._adoptedLanguageIndicator ?? this._ownLanguageIndicator;
    }

    /**
     * Whether the hidden icons are currently shown to the user.
     */
    get hiddenIconsRevealed() {
        return this._hiddenIconsRevealed;
    }

    /**
     * Index of the first tray icon: the tray area always starts right after the
     * fold button, which itself sits right after the language area.
     */
    getTrayIconIndex() {
        const foldButton = this._placeFoldButton();
        const box = this._getBox();

        if (foldButton.container.get_parent() !== box)
            return 0;

        return box.get_children().indexOf(foldButton.container) + 1;
    }

    /**
     * Adds an icon to the tray area.
     *
     * @param {BaseStatusIcon} icon the tray icon to place.
     */
    placeInTrayArea(icon) {
        this.registerTrayIcon(icon);

        const box = this._getBox();

        // Tray icons are always inserted right after the fold button, so an
        // icon that is already in the managed box is already in place.
        if (icon.container.get_parent() === box)
            return;

        const role = `appindicator-${icon.uniqueId}`;
        const currentIcon = Main.panel.statusArea[role];

        if (currentIcon) {
            if (currentIcon !== icon)
                currentIcon.destroy();

            Main.panel.statusArea[role] = null;
        }

        Main.panel.addToStatusArea(role, icon, this.getTrayIconIndex(), this.boxName);
    }

    /**
     * Tracks a tray icon, so that the tray area can be kept in a sane state.
     *
     * @param {BaseStatusIcon} icon the icon to track.
     */
    registerTrayIcon(icon) {
        if (this._trayIcons.has(icon))
            return;

        this._trayIcons.add(icon);
        this._publishKnownIcons();
    }

    /**
     * @param {BaseStatusIcon} icon the icon that is gone.
     */
    unregisterTrayIcon(icon) {
        if (this._trayIcons.delete(icon))
            this._publishKnownIcons();
    }

    /**
     * @param {string} uniqueId the id of an indicator.
     * @returns {boolean} whether that indicator has to stay out of the tray area
     *   right now.
     */
    isIconHidden(uniqueId) {
        return this._hiddenIcons.has(uniqueId) && !this._hiddenIconsRevealed;
    }

    /**
     * Shows or hides the icons the user has hidden.
     */
    toggleHiddenIcons() {
        if (!this._hiddenIcons.size)
            return;

        this._hiddenIconsRevealed = !this._hiddenIconsRevealed;

        this._foldButton?.setRevealed(this._hiddenIconsRevealed);
        this._updateIconsVisibility();
    }

    /**
     * Re-applies the position of every area we own.
     */
    relayout() {
        if (!Main.panel)
            return;

        this._placeLanguageArea();
        this._placeFoldButton();

        // Icons only move when the box they live in changed, see placeInTrayArea().
        for (const icon of [...this._trayIcons])
            icon.placeInPanel();
    }

    /**
     * Keeps the language area at the leftmost index of the managed panel box.
     *
     * @returns {PanelMenu.Button|null} the language area, if there is one.
     */
    _placeLanguageArea() {
        if (!this._getSettings().get_boolean('language-area-enabled')) {
            this._releaseLanguageArea();
            return null;
        }

        const indicator = this._getLanguageIndicator();
        if (indicator)
            this._moveToBox(indicator.container, this._getBox(), 0);

        return indicator;
    }

    /**
     * Returns the fold button, creating it when needed.
     */
    _getFoldButton() {
        if (!this._foldButton) {
            this._foldButton = new TrayFoldButton();
            Main.panel.addToStatusArea(FOLD_BUTTON_ROLE, this._foldButton, 0,
                this.boxName);
        }

        return this._foldButton;
    }

    /**
     * Keeps the fold button right after the language area, i.e. at the left of
     * the tray area.
     *
     * @returns {PanelMenu.Button} the fold button.
     */
    _placeFoldButton() {
        const foldButton = this._getFoldButton();
        const box = this._getBox();
        const languageArea = this._placeLanguageArea();

        let index = 0;
        if (languageArea && languageArea.container.get_parent() === box)
            index = box.get_children().indexOf(languageArea.container) + 1;

        // The button stays in the panel even without hidden icons, so that the
        // tray area never moves; it's just invisible then.
        foldButton.visible = this._hiddenIcons.size > 0;
        foldButton.setRevealed(this._hiddenIconsRevealed);

        this._moveToBox(foldButton.container, box, index);

        return foldButton;
    }

    _updateHiddenIcons() {
        this._hiddenIcons = new Set(this._getSettings().get_strv('hidden-icons'));

        // Nothing left to reveal, so collapse back.
        if (!this._hiddenIcons.size)
            this._hiddenIconsRevealed = false;

        if (this._foldButton) {
            this._foldButton.visible = this._hiddenIcons.size > 0;
            this._foldButton.setRevealed(this._hiddenIconsRevealed);
        }

        this._updateIconsVisibility();
    }

    _updateIconsVisibility() {
        for (const icon of [...this._trayIcons])
            icon.updateHiddenState();
    }

    /**
     * Publishes the icons we know about, so that the preferences can offer them
     * by name instead of asking for their id.
     */
    _publishKnownIcons() {
        const settings = this._getSettings();
        const knownIcons = [...this._trayIcons].map(icon =>
            [icon.uniqueId, icon.displayName || icon.uniqueId]);

        const value = new GLib.Variant('a(ss)', knownIcons);
        if (!settings.get_value('known-icons').equal(value))
            settings.set_value('known-icons', value);
    }

    _getSettings() {
        return SettingsManager.getDefaultGSettings();
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
        this._trayIcons.clear();

        if (this._foldButton) {
            Main.panel.statusArea[FOLD_BUTTON_ROLE] = null;
            this._foldButton.destroy();
            this._foldButton = null;
        }

        // connectSmart() drops every connection we made once we emit this.
        this.emit('destroy');
    }
}
