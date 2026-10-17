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

/** How long an icon takes to appear in, or to leave, the tray area, in ms. */
const FOLD_ANIMATION_DURATION = 220;

/**
 * How far an icon shrinks while it is folded away. The icon is faded out at
 * the same time, so it does not disappear abruptly.
 */
const FOLDED_ICON_SCALE = 0.5;

/**
 * The space every panel item of ours keeps on both of its sides, in pixels per
 * side, as the "Icon Spacing" setting in the preferences asks for it.
 */
const getIconSpacing = () =>
    SettingsManager.getDefaultGSettings().get_int('tray-icon-spacing');

/**
 * The inline style that gives a panel button the spacing above.
 *
 * A PanelMenu.Button does not lay CSS padding out at all: it sizes itself from
 * the -natural-hpadding/-minimum-hpadding of its theme node (see ButtonBox in
 * the shell's panelMenu.js), so that is where the spacing of a panel item has
 * to go. The shell theme asks for a padding of its own there, both values are
 * written so that neither of them gets in the way.
 */
const getIconSpacingStyle = () => {
    const spacing = getIconSpacing();

    return `-natural-hpadding: ${spacing}px; -minimum-hpadding: ${spacing}px`;
};

let panelAreas;

/**
 * The button that sits between the language area and the tray area and shows
 * the icons that do not fit into the tray area.
 */
export const TrayFoldButton = GObject.registerClass(
class AppIndicatorTrayFoldButton extends PanelMenu.Button {
    /**
     * The icons that are folded away are the ones the button points at: it is
     * at the left of the tray area, so its arrow points left while they are
     * hidden and right once they are back next to it.
     *
     * The start/end arrows are used rather than the left/right ones the names
     * suggest, so that the arrow follows the text direction of the shell: they
     * are mirrored in a right to left session like the panel itself is.
     */
    static get FOLDED_ICON() {
        return 'pan-start-symbolic';
    }

    static get EXPANDED_ICON() {
        return 'pan-end-symbolic';
    }

    _init() {
        // No menu: clicking this button only unfolds the tray icons.
        super._init(0.5, 'More tray icons', true);

        this.add_style_class_name('appindicator-fold-button');

        this._foldIcon = new St.Icon({
            style_class: 'system-status-icon',
            icon_name: TrayFoldButton.FOLDED_ICON,
        });

        // The shell theme gives the icons inside a panel button a padding and a
        // margin of their own. The arrow leaves the spacing around it to the
        // button, which is where the user's icon spacing goes, see
        // PanelAreas._applyIconSpacing().
        this._foldIcon.set_style('padding: 0; margin: 0');
        this.add_child(this._foldIcon);

        this._foldGesture = new Clutter.ClickGesture();
        this._foldGesture.set_recognize_on_press(true);
        this._foldGesture.connect('recognize',
            () => PanelAreas.getDefault()?.toggleExpanded());
        this.add_action(this._foldGesture);
    }

    /**
     * @param {boolean} expanded whether the tray area shows every icon.
     */
    setExpanded(expanded) {
        this._foldIcon.icon_name = expanded
            ? TrayFoldButton.EXPANDED_ICON : TrayFoldButton.FOLDED_ICON;
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
 * language area (see addIconToPanel() in indicatorStatusIcon.js). It only shows
 * the number of icons the user asked for, the ones beyond that number are
 * folded away behind the fold button, which shows and hides them again. Icons
 * that show nothing at all are not counted, see _visibleIcons().
 *
 * The icons of the tray area can be rearranged by dragging them around, in the
 * folded and in the unfolded state alike: the order the user drags them into is
 * the order the fold follows.
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

        // The order the user dragged the icons into, how many of them the tray
        // area shows at once, and whether the user unfolded the rest. The last
        // one is the user's own state, the fold button is the only thing that
        // changes it, see _syncIcons().
        this._iconOrder = settings.get_strv('icon-order');
        this._maxVisibleIcons = settings.get_int('max-visible-icons');
        this._iconsExpanded = false;

        // The icons that are folded away right now.
        this._foldedIcons = new Set();

        this._press = null;
        this._drag = null;
        this._capturedEventId = 0;

        Util.connectSmart(settings, 'changed::tray-pos', this, () => this.relayout());
        Util.connectSmart(settings, 'changed::language-area-enabled', this,
            () => this.relayout());
        Util.connectSmart(settings, 'changed::max-visible-icons', this,
            () => this._updateMaxVisibleIcons());
        Util.connectSmart(settings, 'changed::icon-order', this,
            () => this._updateIconOrder());
        Util.connectSmart(settings, 'changed::icon-size', this, () => this.relayout());
        Util.connectSmart(settings, 'changed::tray-icon-spacing', this,
            () => this._updateIconSpacing());
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
        // that the tray area below decides where it lives.
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

        // An icon gets something to show, or loses it, without showing up or
        // leaving: an appindicator goes passive while its window is open, an
        // icon is only ready once it has loaded its pixmap. That is one icon
        // more or less for the tray area, so it is laid out again, see
        // _visibleIcons(). The connection needs no teardown of its own: it sits
        // on the icon, which is destroyed when it leaves the tray area.
        icon.connect('notify::visible', () => this.relayout());
    }

    /**
     * @param {BaseStatusIcon} icon the icon that is gone.
     */
    unregisterTrayIcon(icon) {
        // The icon is forgotten first: it is on its way out, so it must not
        // take part in the relayout the cancelled drag does.
        const known = this._trayIcons.delete(icon);
        this._foldedIcons.delete(icon);

        if (this._drag?.icon === icon) {
            // Stopping the drag lays the areas out again on its own.
            this._cancelDrag();
        } else if (known) {
            // One icon less to fold: whether the fold button is still needed,
            // and whether the icons it folded away fit into the tray area now,
            // is decided again.
            this.relayout();
        }

        if (!known)
            return;

        this._teardownDrag(icon);
    }

    /**
     * Shows every tray icon, or folds the ones that do not fit into the tray
     * area away again.
     */
    toggleExpanded() {
        if (!this._hasIconOverflow())
            return;

        this._iconsExpanded = !this._iconsExpanded;
        this._syncIcons();
    }

    /**
     * Re-applies the position of every area we own.
     */
    relayout() {
        if (!Main.panel)
            return;

        this._syncIcons();
    }

    /**
     * Places the language area, the fold button and every icon we know about.
     */
    _syncIcons() {
        this._placeLanguageArea();
        this._placeFoldButton();

        const icons = this._sortedIcons();
        const visibleIcons = this._visibleIcons(icons);
        const overflow = this._hasIconOverflow(visibleIcons);

        // Whether the icons are unfolded is the user's own state, it survives
        // the icons that show up or leave: the fold button is the only thing
        // that changes it. With nothing to fold there is nothing to unfold
        // either, and the fold button is not shown at all, see _placeFoldButton().
        const visibleCount = overflow && !this._iconsExpanded
            ? this._maxVisibleIcons : visibleIcons.length;

        // The tray area starts right after the fold button, so that the
        // language area can never be pushed away by the tray icons.
        this._layoutBox(this._getBox(), this._getTrayStartIndex(), icons);

        // Only the icons that show something take part in the fold, the others
        // are never seen and keep whatever state they are in: an icon that gets
        // something to show again is folded, or unfolded, right away, see
        // registerTrayIcon().
        visibleIcons.forEach((icon, index) =>
            this._foldIcon(icon, index >= visibleCount));
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
        if (indicator) {
            this._applyIconSpacing(indicator);
            this._moveToBox(indicator.container, this._getBox(), 0);
        }

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

        // The icon is only shown while there is something to fold away, but the
        // container stays in the panel either way: the tray area is always
        // placed right after it, whatever it shows.
        foldButton.container.visible = this._hasIconOverflow();
        foldButton.setExpanded(this._iconsExpanded);
        this._applyIconSpacing(foldButton);

        this._moveToBox(foldButton.container, box, index);

        return foldButton;
    }

    /**
     * Gives a panel item the spacing the user asked for.
     *
     * The language area and the fold button sit in the very same row as the tray
     * icons, so they keep the same space on both of their sides: moving the "Icon
     * Spacing" slider in the preferences has to move the gaps around them as
     * well, not only the gaps between the tray icons.
     *
     * @param {PanelMenu.Button|null} indicator the panel item to space out.
     */
    _applyIconSpacing(indicator) {
        if (!indicator)
            return;

        const style = getIconSpacingStyle();

        // Placing the areas happens on every relayout, and a style that is
        // already in place would only give the panel a relayout to do.
        if (indicator.get_style() === style)
            return;

        indicator.set_style(style);

        // St keeps the size it computed for an actor until a relayout is asked
        // for, see applyIconSpacing() in indicatorStatusIcon.js.
        for (const actor of [indicator, indicator.container]) {
            if (actor)
                actor.queue_relayout();
        }
    }

    /**
     * Brings the spacing of every panel item we own in line with the setting.
     */
    _updateIconSpacing() {
        this._applyIconSpacing(this.languageArea);
        this._applyIconSpacing(this._foldButton);
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
     * @param {BaseStatusIcon[]} [visibleIcons] the icons that show something,
     *     see _visibleIcons().
     * @returns {boolean} whether there are more icons than the tray area shows.
     */
    _hasIconOverflow(visibleIcons = this._visibleIcons()) {
        return visibleIcons.length > this._maxVisibleIcons;
    }

    /**
     * Every icon we know about, in the order the user arranged them in.
     *
     * @returns {BaseStatusIcon[]} the icons, in display order.
     */
    _sortedIcons() {
        const allIcons = [...this._trayIcons];
        const positions = new Map(allIcons.map((icon, index) => [icon, index]));
        const order = new Map(this._iconOrder.map((id, index) => [id, index]));

        const orderIndex = icon => order.get(icon.uniqueId) ?? Number.MAX_SAFE_INTEGER;

        // Icons the user never dragged keep the order they showed up in.
        return allIcons.sort((a, b) =>
            orderIndex(a) - orderIndex(b) || positions.get(a) - positions.get(b));
    }

    /**
     * The icons that show something right now, in display order.
     *
     * An icon that is not ready yet, and an icon the app asked for to stay
     * hidden, shows nothing at all (see _updateVisibility() in
     * indicatorStatusIcon.js): it is not part of what the tray area shows, so it
     * takes part in neither the number of icons the tray area shows at once nor
     * the fold.
     *
     * @param {BaseStatusIcon[]} [icons] the icons to pick from, in display
     *     order.
     * @returns {BaseStatusIcon[]} the icons that show something.
     */
    _visibleIcons(icons = this._sortedIcons()) {
        return icons.filter(icon => icon.visible);
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

    /**
     * Picks the new limit up and folds the icons that do not fit anymore away.
     * Whether the icons stay unfolded is the user's state, see _syncIcons().
     */
    _updateMaxVisibleIcons() {
        this._maxVisibleIcons = this._getSettings().get_int('max-visible-icons');
        this.relayout();
    }

    /**
     * Shows one tray icon, or folds it away, with an animation.
     *
     * @param {BaseStatusIcon} icon the icon to show or fold away.
     * @param {boolean} folded whether it has to leave the tray area.
     */
    _foldIcon(icon, folded) {
        const actor = icon.container;

        // Icons that are already where they belong are left alone, so that a
        // relayout does not restart the animation of the icons that are on
        // their way in or out.
        if (folded === this._foldedIcons.has(icon))
            return;

        if (folded)
            this._foldedIcons.add(icon);
        else
            this._foldedIcons.delete(icon);

        // The icon shrinks towards its own middle, wherever it sits in the panel.
        actor.set_pivot_point(0.5, 0.5);

        if (folded) {
            // The tray area gives the room of the icon up once it is gone, so
            // the icons next to it move after the animation, not during it.
            actor.ease({
                opacity: 0,
                scale_x: FOLDED_ICON_SCALE,
                scale_y: FOLDED_ICON_SCALE,
                duration: FOLD_ANIMATION_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    actor.hide();
                    this._resetIconAnimation(icon);
                },
            });
        } else {
            // Showing the icon takes its room back right away, the icon itself
            // fades into the place its neighbours just made for it.
            actor.show();
            actor.opacity = 0;
            actor.set_scale(FOLDED_ICON_SCALE, FOLDED_ICON_SCALE);
            actor.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration: FOLD_ANIMATION_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /**
     * Puts an icon that has been folded away back into the state it has when it
     * is shown, so that it can be faded in again the next time it is needed.
     *
     * @param {BaseStatusIcon} icon the icon that is out of the tray area.
     */
    _resetIconAnimation(icon) {
        const actor = icon.container;

        actor.opacity = 255;
        actor.set_scale(1, 1);
    }

    /**
     * Writes the order the icons are currently displayed in.
     */
    _persistOrder() {
        const order = [];
        const box = this._getBox();

        for (const child of box.get_children()) {
            const icon = this._iconForContainer(child);
            if (icon)
                order.push(icon.uniqueId);
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
            // The spacing the indicator was given goes with the area, the shell
            // puts its own one back on once the setting is turned on again.
            adopted.set_style('');

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
     * Dragging the icons around.
     */

    /**
     * Makes an icon draggable: pressing it and moving the pointer moves it
     * inside the tray area, which is how the order of the icons is changed.
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

        if (!icon || !this._isPointInside(Main.panel, x, y))
            return;

        const box = this._getBox();
        const start = this._getFoldButtonContainer(box);

        if (!start)
            return;

        const anchor = this._findDropAnchor(box, x, icon.container, start);
        this._moveActorAfter(icon.container, box, anchor);
    }

    /**
     * The icon the dragged one has to be placed after so that it lands under
     * the pointer. Only the icons of `box` that are shown are taken into
     * account, whatever else the box holds (the language area, the fold button,
     * the icons that are folded away, other panel items, ...) keeps its place.
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
            const icon = this._iconForContainer(child);

            // The icons that are folded away are not on the panel, so they
            // cannot be aimed at: dropping on them would hide the icon that is
            // being dragged.
            if (child === dragged || !icon || !child.visible)
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
        if (!this._drag)
            return;

        this._stopDrag();

        // The icons followed the pointer while dragging, the order is only
        // written now, so that a cancelled drag simply restores the old state.
        this._persistOrder();
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

        if (this._capturedEventId) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }

        // The icon may have been destroyed while it was being dragged.
        if (this._trayIcons.has(drag.icon))
            drag.icon.container.opacity = 255;

        drag.clone.destroy();
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

        for (const icon of [...this._dragHandlers.keys()])
            this._teardownDrag(icon);
        this._dragHandlers.clear();

        this._releaseLanguageArea();

        // The icons that are folded away have to be shown again: neither the
        // limit nor the fold button stays behind when the extension goes away.
        for (const icon of this._foldedIcons) {
            icon.container.show();
            this._resetIconAnimation(icon);
        }

        this._foldedIcons.clear();
        this._trayIcons.clear();

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
