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

/** Gap between the panel bar and the floating panel below it. */
const PANEL_GAP = 6;

let panelAreas;

/**
 * The button that sits between the language area and the tray area and opens
 * the floating panel holding the icons the user hid.
 */
export const TrayFoldButton = GObject.registerClass(
class AppIndicatorTrayFoldButton extends PanelMenu.Button {
    static get COLLAPSED_ICON() {
        return 'pan-down-symbolic';
    }

    static get REVEALED_ICON() {
        return 'pan-up-symbolic';
    }

    _init() {
        // No menu: clicking this button only opens the hidden icons panel.
        super._init(0.5, 'Hidden tray icons', true);

        this.add_style_class_name('appindicator-fold-button');

        this._foldIcon = new St.Icon({
            style_class: 'system-status-icon',
            icon_name: TrayFoldButton.COLLAPSED_ICON,
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
            ? TrayFoldButton.REVEALED_ICON : TrayFoldButton.COLLAPSED_ICON;
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
 *
 * Icons the user does not want in the panel bar are kept in a floating panel
 * below it, which the fold button shows and hides.
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

        const settings = this._getSettings();

        this._adoptedLanguageIndicator = null;
        this._ownLanguageIndicator = null;
        this._foldButton = null;

        // Every icon we know about, in the order it showed up in.
        this._trayIcons = new Set();

        // The ids of the icons living in the floating panel.
        this._hiddenIcons = new Set(settings.get_strv('hidden-icons'));
        this._hiddenIconsRevealed = false;

        this._hiddenPanel = null;
        this._hiddenPanelBox = null;

        Util.connectSmart(settings, 'changed::tray-pos', this, () => this.relayout());
        Util.connectSmart(settings, 'changed::language-area-enabled', this,
            () => this.relayout());
        Util.connectSmart(settings, 'changed::hidden-icons', this,
            () => this._updateHiddenIcons());
        Util.connectSmart(settings, 'changed::icon-size', this, () => this.relayout());
        Util.connectSmart(settings, 'changed::tray-icon-spacing', this,
            () => this._queuePanelReposition());
        Util.connectSmart(Main.sessionMode, 'updated', this, () => this.relayout());

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
     * Whether the floating panel with the hidden icons is currently shown.
     */
    get hiddenIconsRevealed() {
        return this._hiddenIconsRevealed;
    }

    /**
     * @param {string} uniqueId the id of an indicator.
     * @returns {boolean} whether that indicator lives in the floating panel.
     */
    isIconHidden(uniqueId) {
        return this._hiddenIcons.has(uniqueId);
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
     * Adds an icon to the tray area (or to the floating panel, when the user
     * asked for it to be hidden).
     *
     * @param {BaseStatusIcon} icon the tray icon to place.
     */
    placeInTrayArea(icon) {
        const box = this._getBox();
        const role = this._roleFor(icon);
        const currentIcon = Main.panel.statusArea[role];

        if (currentIcon) {
            if (currentIcon !== icon)
                currentIcon.destroy();

            Main.panel.statusArea[role] = null;
        }

        this.registerTrayIcon(icon);

        // The first time we see an icon the shell registers it for us, after
        // that the areas below decide where it lives.
        if (icon.container.get_parent() !== box && !Main.panel.statusArea[role]) {
            Main.panel.addToStatusArea(role, icon, this.getTrayIconIndex(),
                this.boxName);
        }

        this._syncIcons();
    }

    /**
     * Tracks a tray icon, so that the areas can be kept in a sane state.
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
        if (!this._trayIcons.delete(icon))
            return;

        this._publishKnownIcons();
    }

    /**
     * Shows or hides the floating panel holding the hidden icons.
     */
    toggleHiddenIcons() {
        if (!this._hiddenIcons.size)
            return;

        this._hiddenIconsRevealed = !this._hiddenIconsRevealed;

        this._foldButton?.setRevealed(this._hiddenIconsRevealed);
        this._updateHiddenPanel();
    }

    /**
     * Re-applies the position of every area we own.
     */
    relayout() {
        if (!Main.panel)
            return;

        this._syncIcons();
        this._updateHiddenPanel();
    }

    /**
     * Places the language area, the fold button and every icon we know about.
     */
    _syncIcons() {
        this._placeLanguageArea();
        this._placeFoldButton();

        const trayIcons = this._sortedIcons(
            icon => !this._hiddenIcons.has(icon.uniqueId));
        const hiddenIcons = this._sortedIcons(
            icon => this._hiddenIcons.has(icon.uniqueId));

        // The tray area starts right after the fold button, so that the
        // language area can never be pushed away by the tray icons.
        this._layoutBox(this._getBox(), this._getTrayStartIndex(), trayIcons);

        if (hiddenIcons.length || this._hiddenPanel)
            this._layoutBox(this._getHiddenPanelBox(), 0, hiddenIcons);
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
            // A button left over from a previous load of the extension would
            // make the shell refuse to register another one for the same role.
            const orphan = Main.panel.statusArea[FOLD_BUTTON_ROLE];
            if (orphan) {
                Util.Logger.warn('Replacing the fold button that is already there');
                orphan.destroy();
                delete Main.panel.statusArea[FOLD_BUTTON_ROLE];
            }

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

    /**
     * Index right after the fold button, i.e. where the tray area starts.
     */
    _getTrayStartIndex() {
        const box = this._getBox();
        const foldButton = this._foldButton;

        if (!foldButton || foldButton.container.get_parent() !== box)
            return 0;

        return box.get_children().indexOf(foldButton.container) + 1;
    }

    /**
     * The icons we know about that have to be in the tray area or in the
     * floating panel, in the order they showed up in.
     *
     * @param {Function} filter picks the icons of one of the two areas.
     * @returns {BaseStatusIcon[]} the icons, in display order.
     */
    _sortedIcons(filter) {
        return [...this._trayIcons].filter(filter);
    }

    /**
     * Puts `icons` into `box`, starting at `startIndex`, in that order.
     *
     * @param {St.BoxLayout} box the box to fill.
     * @param {number} startIndex the index of the first icon.
     * @param {BaseStatusIcon[]} icons the icons, in the order they belong in.
     */
    _layoutBox(box, startIndex, icons) {
        let index = startIndex;

        for (const icon of icons) {
            const actor = icon.container;
            const current = box.get_children().indexOf(actor);

            if (current !== index) {
                if (actor.get_parent())
                    actor.get_parent().remove_child(actor);

                box.insert_child_at_index(actor,
                    Math.min(index, box.get_n_children()));
            }

            index++;
        }
    }

    _updateHiddenIcons() {
        this._hiddenIcons = new Set(this._getSettings().get_strv('hidden-icons'));

        // Nothing left to show, so collapse back.
        if (!this._hiddenIcons.size)
            this._hiddenIconsRevealed = false;

        this.relayout();
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

    _roleFor(icon) {
        return `appindicator-${icon.uniqueId}`;
    }

    /**
     * @param {Clutter.Actor} container the container of an icon.
     * @returns {BaseStatusIcon|null} the icon that owns it, if it is one of us.
     */
    _iconForContainer(container) {
        for (const icon of this._trayIcons) {
            if (icon.container === container)
                return icon;
        }

        return null;
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

    /*
     * The floating panel with the hidden icons.
     */

    /**
     * The box the hidden icons live in; the panel behind it is created on
     * demand, and it stays hidden until the user opens it.
     *
     * @returns {St.BoxLayout} the box holding the hidden icons.
     */
    _getHiddenPanelBox() {
        if (!this._hiddenPanel) {
            this._hiddenPanelBox = new St.BoxLayout({
                style_class: 'appindicator-hidden-panel',
            });

            // The shell theme styles this class like a floating menu, so the
            // panel looks native in the dark and in the light theme alike.
            this._hiddenPanel = new St.Bin({
                style_class: 'popup-menu-content appindicator-hidden-panel-container',
                child: this._hiddenPanelBox,
                reactive: true,
                visible: false,
            });

            Util.addActor(Main.uiGroup, this._hiddenPanel);
        }

        return this._hiddenPanelBox;
    }

    /**
     * Shows or hides the floating panel.
     */
    _updateHiddenPanel() {
        const hasHiddenIcons = this._hiddenIcons.size > 0;
        const shouldShow = hasHiddenIcons && this._hiddenIconsRevealed;

        if (!shouldShow) {
            this._hiddenPanel?.hide();
            return;
        }

        this._getHiddenPanelBox();
        this._hiddenPanel.show();
        this._updateHiddenPanelPosition();
    }

    /**
     * Puts the floating panel right below the left end of the tray area.
     */
    _updateHiddenPanelPosition() {
        const panel = this._hiddenPanel;

        if (!panel?.visible)
            return;

        const anchor = this._getHiddenPanelAnchor();
        const monitor = Main.layoutManager.primaryMonitor;

        if (!anchor || !monitor)
            return;

        const {x, y, width, height} = this._getGeometry(anchor);
        const [, panelWidth] = panel.get_preferred_width(-1);

        const minX = monitor.x + PANEL_GAP;
        const maxX = monitor.x + monitor.width - panelWidth - PANEL_GAP;

        panel.set_position(Math.round(Math.min(Math.max(x + width - panelWidth, minX),
            maxX)), Math.round(y + height + PANEL_GAP));
    }

    /**
     * Repositions the floating panel once the icons had their say: their size
     * only changes after we are notified about the setting, so the panel is
     * moved on the next idle instead of right away.
     */
    _queuePanelReposition() {
        if (!this._hiddenPanel?.visible || this._repositionId)
            return;

        this._repositionId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            delete this._repositionId;
            this._updateHiddenPanelPosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * The actor the floating panel is aligned with: the fold button when it is
     * visible, otherwise the first tray icon (the panel has to be reachable
     * even while there is nothing hidden yet).
     *
     * @returns {Clutter.Actor|null} the actor to align with.
     */
    _getHiddenPanelAnchor() {
        const box = this._getBox();

        if (this._foldButton?.visible &&
            this._foldButton.container.get_parent() === box)
            return this._foldButton.container;

        for (const child of box.get_children()) {
            const icon = this._iconForContainer(child);
            if (icon?.visible && !this.isIconHidden(icon.uniqueId))
                return child;
        }

        const {languageArea} = this;
        if (languageArea?.container.get_parent() === box)
            return languageArea.container;

        return null;
    }

    /*
     * Small Clutter helpers.
     */

    _getGeometry(actor) {
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();

        return {x, y, width, height};
    }

    destroy() {
        if (this._repositionId) {
            GLib.source_remove(this._repositionId);
            delete this._repositionId;
        }

        this._releaseLanguageArea();
        this._trayIcons.clear();

        if (this._hiddenPanel) {
            // Destroying the panel would destroy the icons living in it, so
            // they are handed back to the panel box first.
            const box = Main.panel ? this._getBox() : null;

            if (box && this._hiddenPanelBox) {
                for (const child of [...this._hiddenPanelBox.get_children()])
                    Util.addActor(box, child);
            }

            this._hiddenPanel.destroy();
            this._hiddenPanel = null;
            this._hiddenPanelBox = null;
        }

        if (this._foldButton) {
            if (Main.panel)
                Main.panel.statusArea[FOLD_BUTTON_ROLE] = null;

            this._foldButton.destroy();
            this._foldButton = null;
        }

        // connectSmart() drops every connection we made once we emit this.
        this.emit('destroy');
    }
}
