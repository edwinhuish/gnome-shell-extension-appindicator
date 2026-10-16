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

/** Pixels the pointer has to move before a press turns into a drag. */
const DRAG_THRESHOLD = 8;

/** Gap the floating panel keeps to the panel bar it is put next to. */
const PANEL_GAP = 6;

/**
 * Extra room around the floating panel. Once an icon is inside the panel the
 * pointer may leave it by that much without the icon jumping back into the
 * tray area, which would otherwise start a back and forth when the panel is
 * resized by the icon that is being moved.
 */
const PANEL_SLACK = 16;

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
 * next to it, which the fold button shows and hides. The floating panel is put
 * on the free side of the bar, i.e. below a bar that sits at the top of the
 * screen and above a bar that sits at the bottom, so that the two never
 * overlap. Both areas can be rearranged by dragging the icons around, and an
 * icon can be dragged from one area into the other one.
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
        this._dragHandlers = new Map();

        // The ids of the icons living in the floating panel, and the order the
        // user dragged the icons into.
        this._hiddenIcons = new Set(settings.get_strv('hidden-icons'));
        this._iconOrder = settings.get_strv('icon-order');
        this._hiddenIconsRevealed = false;

        this._hiddenPanel = null;
        this._hiddenPanelBox = null;

        this._press = null;
        this._drag = null;
        this._panelFrozen = false;
        this._capturedEventId = 0;

        Util.connectSmart(settings, 'changed::tray-pos', this, () => this.relayout());
        Util.connectSmart(settings, 'changed::language-area-enabled', this,
            () => this.relayout());
        Util.connectSmart(settings, 'changed::hidden-icons', this,
            () => this._updateHiddenIcons());
        Util.connectSmart(settings, 'changed::icon-order', this,
            () => this._updateIconOrder());
        Util.connectSmart(settings, 'changed::icon-size', this, () => this.relayout());
        Util.connectSmart(settings, 'changed::tray-icon-spacing', this,
            () => this._queuePanelReposition());
        Util.connectSmart(Main.sessionMode, 'updated', this, () => this.relayout());

        // The floating panel follows the bar it is put next to, so it has to be
        // repositioned when the bar moves to the other side of the screen or
        // changes its height (another icon size, another theme, ...).
        Util.connectSmart(Main.layoutManager.panelBox, 'notify::allocation', this,
            () => this._queuePanelReposition());

        if (Main.panel) {
            Util.connectSmart(Main.panel, 'notify::allocation', this,
                () => this._queuePanelReposition());
        }

        Util.connectSmart(Main.layoutManager, 'monitors-changed', this,
            () => this.relayout());

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
        this._setupDrag(icon);
        this._publishKnownIcons();
    }

    /**
     * @param {BaseStatusIcon} icon the icon that is gone.
     */
    unregisterTrayIcon(icon) {
        // The icon is forgotten first: it is on its way out, so it must not
        // take part in the relayout the cancelled drag does.
        const known = this._trayIcons.delete(icon);

        if (this._drag?.icon === icon)
            this._cancelDrag();

        if (!known)
            return;

        this._teardownDrag(icon);
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
     * floating panel, in the order the user arranged them in.
     *
     * @param {Function} filter picks the icons of one of the two areas.
     * @returns {BaseStatusIcon[]} the icons, in display order.
     */
    _sortedIcons(filter) {
        const allIcons = [...this._trayIcons];
        const positions = new Map(allIcons.map((icon, index) => [icon, index]));
        const order = new Map(this._iconOrder.map((id, index) => [id, index]));

        const orderIndex = icon => order.get(icon.uniqueId) ?? Number.MAX_SAFE_INTEGER;

        // Icons the user never dragged keep the order they showed up in.
        return allIcons.filter(filter).sort((a, b) =>
            orderIndex(a) - orderIndex(b) || positions.get(a) - positions.get(b));
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
            // The icon that is being dragged is placed by the drag itself.
            if (icon === this._drag?.icon)
                continue;

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

    _updateIconOrder() {
        this._iconOrder = this._getSettings().get_strv('icon-order');
        this._syncIcons();
    }

    _updateHiddenIcons() {
        this._hiddenIcons = new Set(this._getSettings().get_strv('hidden-icons'));

        // Nothing left to show, so collapse back.
        if (!this._hiddenIcons.size)
            this._hiddenIconsRevealed = false;

        this.relayout();
    }

    /**
     * Writes the order the icons are currently displayed in.
     */
    _persistOrder() {
        const order = [];

        for (const box of [this._getBox(), this._hiddenPanelBox]) {
            if (!box)
                continue;

            for (const child of box.get_children()) {
                const icon = this._iconForContainer(child);
                if (icon)
                    order.push(icon.uniqueId);
            }
        }

        const known = new Set(order);
        for (const id of this._iconOrder) {
            if (!known.has(id)) {
                known.add(id);
                order.push(id);
            }
        }

        if (order.join('\n') === this._iconOrder.join('\n'))
            return;

        this._iconOrder = order;
        this._getSettings().set_strv('icon-order', order);
    }

    /**
     * @param {string} uniqueId the id of an indicator.
     * @param {boolean} hidden whether it belongs into the floating panel.
     */
    _setIconHidden(uniqueId, hidden) {
        const settings = this._getSettings();
        const hiddenIcons = new Set(settings.get_strv('hidden-icons'));
        const changed = hidden
            ? !hiddenIcons.has(uniqueId) : hiddenIcons.delete(uniqueId);

        if (!changed)
            return;

        if (hidden)
            hiddenIcons.add(uniqueId);

        settings.set_strv('hidden-icons', [...hiddenIcons]);
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
                // Keeps the panel usable as a drop target while it is empty.
                style: 'min-width: 44px',
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
        const shouldShow = (hasHiddenIcons && this._hiddenIconsRevealed) ||
            !!this._drag;

        if (!shouldShow) {
            this._hiddenPanel?.hide();
            return;
        }

        this._getHiddenPanelBox();
        this._hiddenPanel.show();
        this._updateHiddenPanelPosition();
    }

    /**
     * Puts the floating panel next to the left end of the tray area, on the
     * free side of the panel bar: below a bar that is at the top of the screen
     * and above a bar that is at the bottom, so that the panel never overlaps
     * the bar, whatever its position and its height are.
     */
    _updateHiddenPanelPosition() {
        const panel = this._hiddenPanel;

        if (this._panelFrozen || !panel?.visible)
            return;

        const anchor = this._getHiddenPanelAnchor();
        const monitor = Main.layoutManager.primaryMonitor;

        if (!anchor || !monitor)
            return;

        const {x, y, width, height} = this._getGeometry(anchor);
        const bar = this._getPanelBar();
        const [, panelWidth] = panel.get_preferred_width(-1);
        const [, panelHeight] = panel.get_preferred_height(-1);

        const minX = monitor.x + PANEL_GAP;
        const maxX = monitor.x + monitor.width - panelWidth - PANEL_GAP;

        // Without a bar to measure, the anchor is what the panel is put next
        // to, which is where the bar would have been.
        const wantedY = bar?.atBottom
            ? bar.y - PANEL_GAP - panelHeight
            : (bar ? bar.y + bar.height : y + height) + PANEL_GAP;

        // The panel stays on the screen, even when it does not fit next to the
        // bar anymore.
        const minY = monitor.y + PANEL_GAP;
        const maxY = monitor.y + monitor.height - panelHeight - PANEL_GAP;

        panel.set_position(
            Math.round(Math.min(Math.max(x + width - panelWidth, minX), maxX)),
            Math.round(Math.min(Math.max(wantedY, minY), maxY)));
    }

    /**
     * The vertical geometry of the panel bar the extension areas live in.
     *
     * The bar is measured instead of taken for granted: the shell puts it at
     * the top of the screen, but the layouts of other desktops (Ubuntu's own
     * one, for instance) and the panel extensions move it to the bottom, and
     * its height changes with the theme and with the icons that are in it.
     *
     * @returns {{y: number, height: number, atBottom: boolean}|null} the top,
     *   the height and the side of the screen of the bar, or null when it
     *   cannot be measured.
     */
    _getPanelBar() {
        const monitor = Main.layoutManager.primaryMonitor;

        if (!monitor)
            return null;

        // The bar itself is what gets measured. The panel box that holds it is
        // the fallback for the moments where the bar has no size yet, e.g.
        // while the shell is still building the panel.
        let geometry = Main.panel ? this._getGeometry(Main.panel) : null;

        if (!geometry?.height)
            geometry = this._getGeometry(Main.layoutManager.panelBox);

        if (!geometry.height)
            return null;

        const {y, height} = geometry;

        // A bar whose middle sits in the lower half of the screen is a bar at
        // the bottom, whatever put it there.
        return {
            y,
            height,
            atBottom: y + height / 2 > monitor.y + monitor.height / 2,
        };
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
     * Dragging the icons around.
     */

    /**
     * Makes an icon draggable: pressing it and moving the pointer moves it
     * inside the tray area, into the floating panel, or from there back into
     * the tray area.
     *
     * @param {BaseStatusIcon} icon the icon to make draggable.
     */
    _setupDrag(icon) {
        if (this._dragHandlers.has(icon))
            return;

        const ids = [
            icon.connect('button-press-event',
                (_actor, event) => this._onButtonPress(icon, event)),
            icon.connect('button-release-event',
                (_actor, event) => this._onButtonRelease(icon, event)),
            icon.connect('motion-event',
                (_actor, event) => this._onMotion(icon, event)),
            icon.connect('destroy', () => this._teardownDrag(icon)),
        ];

        this._dragHandlers.set(icon, ids);
    }

    _teardownDrag(icon) {
        const ids = this._dragHandlers.get(icon);

        if (!ids)
            return;

        this._dragHandlers.delete(icon);

        for (const id of ids) {
            try {
                icon.disconnect(id);
            } catch {
                // The icon is gone, its connections went with it.
            }
        }
    }

    _onButtonPress(icon, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) {
            this._press = null;
            return Clutter.EVENT_PROPAGATE;
        }

        const [x, y] = event.get_coords();
        this._press = {icon, x, y};

        // The press may still turn into a normal click, so it is not consumed
        // here; the drag only starts once the pointer moved far enough.
        return Clutter.EVENT_PROPAGATE;
    }

    _onButtonRelease(icon, _event) {
        if (this._press?.icon === icon)
            this._press = null;

        return Clutter.EVENT_PROPAGATE;
    }

    _onMotion(icon, event) {
        const press = this._press;

        if (!press || press.icon !== icon || this._drag)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();

        if (Math.abs(x - press.x) < DRAG_THRESHOLD &&
            Math.abs(y - press.y) < DRAG_THRESHOLD)
            return Clutter.EVENT_PROPAGATE;

        this._startDrag(press, x, y);

        return Clutter.EVENT_STOP;
    }

    /**
     * @param {object} press where the pointer was pressed down.
     * @param {number} x the current pointer position.
     * @param {number} y the current pointer position.
     */
    _startDrag(press, x, y) {
        const {icon} = press;
        const {container} = icon;

        this._press = null;

        // The press already reached the icon and may have made it schedule a
        // menu toggle: a drag must not open the menu on top of it.
        icon.cancelPendingClicks();
        icon.menu?.close();
        icon.remove_style_pseudo_class('active');

        const [containerX, containerY] = container.get_transformed_position();

        const clone = new Clutter.Clone({source: container});
        clone.opacity = 200;
        clone.set_position(Math.round(x - (press.x - containerX)),
            Math.round(y - (press.y - containerY)));
        Util.addActor(Main.uiGroup, clone);

        // The icon itself stays where it is, dimmed, the clone follows the
        // pointer and the icon moves when the pointer reaches its new place.
        container.opacity = 100;

        this._drag = {
            icon,
            clone,
            offsetX: press.x - containerX,
            offsetY: press.y - containerY,
        };

        // The panel has to be there to be a drop target, empty or not.
        this._updateHiddenPanel();

        // It is put in place once and then stays where it is: moving it along
        // with its contents would move the drop target out from under the
        // pointer as soon as an icon lands in it.
        this._panelFrozen = true;

        this._capturedEventId = global.stage.connect('captured-event',
            (_stage, event) => this._onCapturedEvent(event));
    }

    _onCapturedEvent(event) {
        switch (event.type()) {
        case Clutter.EventType.MOTION: {
            const [x, y] = event.get_coords();
            this._moveDrag(x, y);
            return Clutter.EVENT_STOP;
        }
        case Clutter.EventType.BUTTON_RELEASE:
            this._finishDrag();
            return Clutter.EVENT_STOP;
        case Clutter.EventType.KEY_PRESS:
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._cancelDrag();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _moveDrag(x, y) {
        const drag = this._drag;

        if (!drag)
            return;

        drag.clone.set_position(Math.round(x - drag.offsetX),
            Math.round(y - drag.offsetY));

        this._updateDropTarget(x, y);
    }

    /**
     * Moves the dragged icon to where the pointer is, as a live preview of
     * where it will end up.
     *
     * @param {number} x the pointer position.
     * @param {number} y the pointer position.
     */
    _updateDropTarget(x, y) {
        const icon = this._drag?.icon;

        if (!icon)
            return;

        if (this._isOverHiddenPanel(x, y)) {
            const anchor = this._findDropAnchor(this._hiddenPanelBox, x,
                icon.container);
            this._moveActorAfter(icon.container, this._hiddenPanelBox, anchor);
            return;
        }

        if (!this._isPointInside(Main.panel, x, y))
            return;

        const box = this._getBox();
        const start = this._getFoldButtonContainer(box);

        if (!start)
            return;

        const anchor = this._findDropAnchor(box, x, icon.container, start);
        this._moveActorAfter(icon.container, box, anchor);
    }

    /**
     * @param {number} x the pointer position.
     * @param {number} y the pointer position.
     * @returns {boolean} whether the pointer is over the floating panel.
     */
    _isOverHiddenPanel(x, y) {
        if (!this._hiddenPanel?.visible)
            return false;

        const slack = this._isIconInHiddenPanel(this._drag?.icon) ? PANEL_SLACK : 0;

        return this._isPointInside(this._hiddenPanel, x, y, slack);
    }

    _isIconInHiddenPanel(icon) {
        return !!icon && icon.container.get_parent() === this._hiddenPanelBox;
    }

    /**
     * The icon the dragged one has to be placed after so that it lands under
     * the pointer. Only the icons of `box` are taken into account, whatever
     * else the box holds (the language area, the fold button, other panel
     * items, ...) keeps its place.
     *
     * @param {St.BoxLayout} box the box the pointer is in.
     * @param {number} x the pointer position.
     * @param {Clutter.Actor} dragged the container that is being moved.
     * @param {Clutter.Actor|null} start the container the icon may never be
     *   placed in front of.
     * @returns {Clutter.Actor|null} what to place the icon after.
     */
    _findDropAnchor(box, x, dragged, start = null) {
        let anchor = start;

        for (const child of box.get_children()) {
            if (child === dragged || !this._iconForContainer(child))
                continue;

            const {x: childX, width} = this._getGeometry(child);

            if (x < childX + width / 2)
                break;

            anchor = child;
        }

        return anchor;
    }

    /**
     * Moves an actor into `box`, right after `anchor` (or to the front of the
     * box when `anchor` is null).
     *
     * @param {Clutter.Actor} actor the actor to move.
     * @param {St.BoxLayout} box the box it belongs in.
     * @param {Clutter.Actor|null} anchor what it has to follow.
     */
    _moveActorAfter(actor, box, anchor) {
        const children = box.get_children();
        const anchorIndex = anchor ? children.indexOf(anchor) : -1;

        if (actor.get_parent() === box && children.indexOf(actor) === anchorIndex + 1)
            return;

        if (actor.get_parent())
            actor.get_parent().remove_child(actor);

        const index = anchorIndex < 0 ? 0
            : box.get_children().indexOf(anchor) + 1;

        box.insert_child_at_index(actor, Math.min(index, box.get_n_children()));
    }

    _finishDrag() {
        const drag = this._drag;

        if (!drag)
            return;

        const {icon} = drag;
        const inPanel = this._isIconInHiddenPanel(icon);

        this._stopDrag();

        // The areas followed the pointer while dragging, the settings are only
        // written now, so that a cancelled drag simply restores the old state.
        // The order goes first: writing the hidden state moves the icons around
        // and the place the icon was dropped at would be lost otherwise.
        this._persistOrder();
        this._setIconHidden(icon.uniqueId, inPanel);
        this.relayout();
    }

    _cancelDrag() {
        if (!this._drag)
            return;

        this._stopDrag();
        this.relayout();
    }

    /**
     * Gets rid of everything the drag put on the screen and forgets about it.
     */
    _stopDrag() {
        const drag = this._drag;

        if (!drag)
            return;

        this._drag = null;
        this._panelFrozen = false;

        if (this._capturedEventId) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }

        // The icon may have been destroyed while it was being dragged.
        if (this._trayIcons.has(drag.icon))
            drag.icon.container.opacity = 255;

        drag.clone.destroy();

        // The panel was only shown to be a drop target.
        this._updateHiddenPanel();
    }

    /*
     * Small Clutter helpers.
     */

    _getGeometry(actor) {
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();

        return {x, y, width, height};
    }

    _isPointInside(actor, x, y, slack = 0) {
        if (!actor?.visible)
            return false;

        const {x: actorX, y: actorY, width, height} = this._getGeometry(actor);

        return x >= actorX - slack && x < actorX + width + slack &&
            y >= actorY - slack && y < actorY + height + slack;
    }

    /**
     * @param {St.BoxLayout} box a panel box.
     * @returns {Clutter.Actor|null} the fold button, if it is in that box.
     */
    _getFoldButtonContainer(box) {
        const container = this._foldButton?.container;

        return container?.get_parent() === box ? container : null;
    }

    destroy() {
        this._cancelDrag();

        if (this._repositionId) {
            GLib.source_remove(this._repositionId);
            delete this._repositionId;
        }

        for (const icon of [...this._dragHandlers.keys()])
            this._teardownDrag(icon);
        this._dragHandlers.clear();

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
