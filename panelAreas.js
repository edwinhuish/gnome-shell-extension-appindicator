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

import * as PanelBackground from './panelBackground.js';
import * as SettingsManager from './settingsManager.js';
import * as Util from './util.js';

export const LANGUAGE_AREA_ROLE = 'appindicator-language-area';
export const FOLD_BUTTON_ROLE = 'appindicator-fold-button';

const SHELL_LANGUAGE_AREA_ROLE = 'keyboard';
/** The panel item of the input method panel extension (fcitx5, ibus, ...). */
const IME_PANEL_ROLE = 'kimpanel';
const PANEL_BOX_NAMES = ['left', 'center', 'right'];

/** Pixels the pointer has to move before a press turns into a drag. */
const DRAG_THRESHOLD = 8;

/** Gap the floating panel keeps to the panel bar it is put next to. */
const PANEL_GAP = 6;

/**
 * The floating panel is painted with the background of the bar, but never more
 * transparent than this: it is a popup that holds icons and menu labels, and
 * it has to stay readable when the background it follows is (nearly) gone. The
 * transparency the user picked is what the panel is painted with, this is only
 * the floor below which a followed bar is not taken as it is.
 */
const MIN_PANEL_ALPHA = 0.2;

/** The smallest size the floating panel keeps, so it stays a drop target. */
const PANEL_MIN_SIZE = 'min-width: 44px; min-height: 44px';

/**
 * Extra room around the floating panel. Once an icon is inside the panel the
 * pointer may leave it by that much without the icon jumping back into the
 * tray area, which would otherwise start a back and forth when the panel is
 * resized by the icon that is being moved.
 */
const PANEL_SLACK = 16;

/**
 * How many icons the floating panel puts in one row: the first limit that is
 * bigger than the number of hidden icons decides the number of columns.
 */
const PANEL_COLUMN_STEPS = [
    [4, 2],
    [9, 3],
    [16, 4],
    [25, 5],
    [36, 6],
    [49, 7],
];

/** The floating panel never gets more columns than this. */
const MAX_PANEL_COLUMNS = 8;

/**
 * Whether a box lays its children out from the top down.
 *
 * `St.BoxLayout` grew an `orientation` property in GNOME 48; before that the
 * only way to say it is the boolean `vertical`. A GObject constructor throws on
 * a property it does not know, and a throw while the areas are being laid out
 * takes the rest of the layout with it — on a shell where only one of the two
 * exists, passing the other one is enough to make the floating panel never
 * appear at all.
 *
 * @param {St.BoxLayout} box a box.
 * @returns {boolean} whether its children are stacked vertically.
 */
function isVerticalBox(box) {
    if (box.find_property('orientation'))
        return box.orientation === Clutter.Orientation.VERTICAL;

    return box.vertical;
}

/**
 * Turns a box into a row or a column, whichever property the shell has.
 *
 * @param {St.BoxLayout} box a box.
 * @param {boolean} vertical whether its children stack from the top down.
 */
function setBoxOrientation(box, vertical) {
    if (box.find_property('orientation')) {
        box.orientation = vertical
            ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
    } else {
        box.vertical = vertical;
    }
}

/**
 * @param {{red: number, green: number, blue: number}} color a color.
 * @returns {boolean} whether what is written on it has to be light.
 */
const isDarkColor = ({red, green, blue}) =>
    0.2126 * red + 0.7152 * green + 0.0722 * blue < 128;

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
 * The button that sits between the language area and the tray area and opens
 * the floating panel holding the icons the tray area does not show.
 */
export const TrayFoldButton = GObject.registerClass(
class AppIndicatorTrayFoldButton extends PanelMenu.Button {
    /**
     * The panel is opened below the bar (above it when the bar sits at the
     * bottom), so the arrow points down while the panel is closed and up while
     * it is open.
     */
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

        // The shell theme gives the icons inside a panel button a padding and a
        // margin of their own. The arrow leaves the spacing around it to the
        // button, which is where the user's icon spacing goes, see
        // PanelAreas._applyIconSpacing().
        this._foldIcon.set_style('padding: 0; margin: 0');
        this.add_child(this._foldIcon);

        // The button takes the click itself instead of adding a gesture: the
        // gesture PanelMenu.Button owns is turned off as soon as a button
        // declares that it has no menu, and a gesture of our own would depend
        // on a Clutter class that is not handed out to extensions in every
        // shell version. The panel is opened on press, so that it does not
        // have to wait for the release like a menu would.
        this.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            PanelAreas.getDefault()?.toggleHiddenIcons();
            return Clutter.EVENT_STOP;
        });
    }

    /**
     * @param {boolean} revealed whether the floating panel is open.
     */
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
 * The block sits at the start of the panel box we manage, so that it can never
 * be pushed around by the tray icons (or by anything else) that show up later.
 *
 * The language area holds the input method indicator and is put on the side of
 * the tray area that looks towards the rest of the panel, the way the Windows
 * notification area keeps the input method indicator on its inner side: left
 * of the tray icons in the right and in the center box, right of them in the
 * left box (see _imeBeforeTray). The side is the same one in a vertical panel,
 * where the boxes stack along the height of the bar.
 *
 * The tray area is the place where the tray icons are added (see
 * addIconToPanel() in indicatorStatusIcon.js). Icons the user asked to hide
 * are kept in a floating panel next to the bar, which the fold button shows and
 * hides. Icons that show nothing at all are not counted, see _visibleIcons().
 *
 * The floating panel lays its icons out in a grid. Its width follows the number
 * of icons it holds: two icons per row below four icons, three below nine, and
 * so on up to eight per row, so that it stays roughly square and never turns
 * into a single row wider than the screen. It is put on the free side of the
 * bar, i.e. below a bar that sits at the top of the screen, above a bar that
 * sits at the bottom, right of a bar at the left edge and left of a bar at the
 * right edge, so that the two never overlap. It is painted with the background
 * of the bar, transparency included, the way the flyout of the Windows
 * notification area looks like the taskbar it belongs to.
 *
 * The icons can be rearranged by dragging them around, in the tray area and in
 * the floating panel alike, and an icon can be dragged from one area into the
 * other one: where it is dropped decides whether it is hidden.
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
        this._adoptedLanguageHome = null;
        this._adoptedLanguageStyle = null;
        this._ownLanguageIndicator = null;
        this._foldButton = null;

        // Every icon we know about, in the order it showed up in.
        this._trayIcons = new Set();
        this._dragHandlers = new Map();

        // The ids of the icons the user wants in the floating panel, the order
        // they dragged the icons into, and whether the panel is open. The last
        // one is the user's own state, the fold button is the only thing that
        // changes it, see _syncIcons().
        // The ids the user hid, and the ones of those that no icon answered to,
        // which are only worth naming once, see _warnAboutUnmatchedIcons().
        this._hiddenIcons = new Set(settings.get_strv('hidden-icons'));
        this._warnedHiddenIds = new Set();
        this._iconOrder = settings.get_strv('icon-order');
        this._iconsExpanded = false;

        // The floating panel and the rows of the grid the hidden icons live in.
        this._hiddenPanel = null;
        this._hiddenPanelBox = null;
        this._panelRows = [];
        this._repositionId = 0;

        this._press = null;
        this._drag = null;
        this._panelFrozen = false;
        this._capturedEventId = 0;
        this._swallowRelease = false;
        this._droppingIds = false;

        Util.connectSmart(settings, 'changed::tray-pos', this, () => this.relayout());
        Util.connectSmart(settings, 'changed::language-area-enabled', this,
            () => this.relayout());
        Util.connectSmart(settings, 'changed::hidden-icons', this,
            () => this._updateHiddenIcons());
        Util.connectSmart(settings, 'changed::icon-order', this,
            () => this._updateIconOrder());
        Util.connectSmart(settings, 'changed::icon-size', this, () => {
            this.relayout();
            // The icons take their new size after the setting was signalled.
            this._queuePanelReposition();
        });
        Util.connectSmart(settings, 'changed::tray-icon-spacing', this,
            () => this._updateIconSpacing());
        Util.connectSmart(settings, 'changed::language-area-role', this,
            () => this.relayout());
        Util.connectSmart(Main.sessionMode, 'updated', this, () => this.relayout());

        // The floating panel is painted with the background of the bar, which
        // is followed as it changes, transparency included.
        this._background = PanelBackground.PanelBackground.initialize();
        Util.connectSmart(this._background, 'changed', this,
            () => this._applyPanelBackground());

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
     * Whether the input method indicator goes in front of the tray icons.
     *
     * The tray area is the outer end of the panel, so the input method
     * indicator belongs on its inner side, where the Windows notification area
     * keeps it as well: left of the tray icons in the right and in the center
     * box, right of them in the left box. A vertical panel stacks the same
     * order along its height, where the inner side of the left box is the
     * lower one and the inner side of the right box the upper one, which is
     * what this order gives for free.
     *
     * @returns {boolean} whether the language area comes first.
     */
    get _imeBeforeTray() {
        return this.boxName !== 'left';
    }

    /**
     * The index a newly added tray icon starts at.
     *
     * The shell puts the icon into the box for us; where it belongs in the end
     * is decided by _syncIcons(), which knows the side of the tray area.
     *
     * @returns {number} the index to append the icon at.
     */
    getTrayIconIndex() {
        return this._getBox().get_n_children();
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
        this._publishKnownIcons();

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

        if (this._drag?.icon === icon) {
            // Stopping the drag lays the areas out again on its own.
            this._cancelDrag();
        } else if (known) {
            // One icon less to hide: whether the fold button is still needed,
            // and whether the icons it kept in the floating panel fit into the
            // tray area now, is decided again.
            this.relayout();
        }

        if (!known)
            return;

        this._teardownDrag(icon);
        this._publishKnownIcons();
    }

    /**
     * Shows or hides the floating panel holding the icons the tray area does
     * not show.
     */
    toggleHiddenIcons() {
        if (!this._hasHiddenIcons()) {
            // The button is not shown without hidden icons, so this is what a
            // press on a button that is still on screen looks like when the
            // setting and the icons disagree.
            Util.Logger.debug('The fold button was pressed with nothing to fold');
            return;
        }

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
        const icons = this._sortedIcons();
        const visibleIcons = this._visibleIcons(icons);

        // The icons the user hid live in the floating panel, the rest stays in
        // the tray area.
        const trayIcons = visibleIcons.filter(
            icon => !this._hiddenIcons.has(icon.settingsId));
        const hiddenIcons = visibleIcons.filter(
            icon => this._hiddenIcons.has(icon.settingsId));

        // Icons that show nothing are never seen: they are kept in the tray
        // area, where they take no room, instead of the floating panel, so that
        // the panel only counts the icons it actually shows.
        const inactiveIcons = icons.filter(icon => !icon.visible);

        const foldButton = this._placeFoldButton();
        const languageArea = this._placeLanguageArea();

        const trayActors = [...trayIcons, ...inactiveIcons].map(i => i.container);
        const foldActor = foldButton.container;
        const languageActor = languageArea?.container ?? null;

        // One block, in the order the side of the tray area asks for: the
        // language area is never pushed away by the tray icons, and the tray
        // icons stay on the side of the block that looks away from the panel.
        this._layoutGroup(this._getBox(), this._imeBeforeTray
            ? [languageActor, foldActor, ...trayActors]
            : [...trayActors, foldActor, languageActor]);

        this._layoutPanelIcons(hiddenIcons);
        this._updatePanel();
        this._warnAboutUnmatchedIcons(icons);
        this._dropBusIds(icons);
        this._logState();
    }

    /**
     * Drops the ids that were stored under the name an indicator has on the
     * bus.
     *
     * Those ids carry the number of the connection or the process that was
     * exporting the icon, so they cannot match anything again once that process
     * is gone (see settingsId() in util.js). They are only left over from
     * before the settings were given an id that survives a restart, nothing can
     * be done with them: an icon that is not running keeps its id as long as it
     * is the stable one, but an id of the bus kind is dead for good.
     *
     * Only the ids no icon answers to right now are dropped, so a setting that
     * is still in use is never touched, and nothing is dropped while there is
     * no icon at all: that is the moment the shell is still starting and every
     * setting would look unused.
     *
     * @param {BaseStatusIcon[]} icons the icons there are.
     */
    _dropBusIds(icons) {
        if (this._droppingIds || !icons.length)
            return;

        const inUse = new Set(icons.map(icon => icon.settingsId));
        const stale = id => !inUse.has(id) && Util.isUnstableSettingsId(id);

        const hidden = [...this._hiddenIcons].filter(stale);
        const order = this._iconOrder.filter(stale);

        if (!hidden.length && !order.length)
            return;

        const settings = this._getSettings();
        this._droppingIds = true;

        try {
            if (hidden.length) {
                this._hiddenIcons = new Set(
                    [...this._hiddenIcons].filter(id => !stale(id)));
                settings.set_strv('hidden-icons', [...this._hiddenIcons]);
            }

            if (order.length) {
                this._iconOrder = this._iconOrder.filter(id => !stale(id));
                settings.set_strv('icon-order', this._iconOrder);
            }
        } finally {
            this._droppingIds = false;
        }

        Util.Logger.debug('Dropped the ids that name an indicator on the bus: ' +
            `${[...hidden, ...order].join(', ')}`);
    }

    /**
     * Names the ids the user hid that no icon answers to.
     *
     * That is what a hidden icon looks like when the id the preferences wrote
     * is not the id the icon reports: the icon stays in the tray area and the
     * floating panel stays empty, which is hard to tell apart from the feature
     * not working at all. The ids are named once each, icons come and go all
     * the time and the setting keeps the ids of the icons that are gone.
     *
     * @param {BaseStatusIcon[]} icons the icons there are.
     */
    _warnAboutUnmatchedIcons(icons) {
        const known = new Set(icons.map(icon => icon.settingsId));
        const unmatched = [...this._hiddenIcons].filter(id => !known.has(id));

        if (!unmatched.length) {
            this._warnedHiddenIds.clear();
            return;
        }

        const fresh = unmatched.filter(id => !this._warnedHiddenIds.has(id));
        if (!fresh.length)
            return;

        for (const id of fresh)
            this._warnedHiddenIds.add(id);

        Util.Logger.warn('No tray icon answers to the hidden ids ' +
            `${fresh.join(', ')}, there are: ${[...known].join(', ') || 'none'}`);
    }

    /**
     * Writes one line about what the areas hold.
     *
     * Everything the hidden icons feature depends on is in it: how many icons
     * there are, how many the user hid, whether the fold button and the
     * floating panel are on screen. A screenshot cannot tell a panel that is
     * empty from one that was never created, this can.
     *
     * @param {string} [reason] what made the areas be laid out.
     */
    _logState(reason = 'sync') {
        Util.Logger.debug(`Panel areas (${reason}, box=${this.boxName}): ` +
            `tray=${this._trayIcons.size}, hidden=${this._hiddenIcons.size}, ` +
            `fold=${this._foldButton?.container.visible ?? false}, ` +
            `expanded=${this._iconsExpanded}, ` +
            `panel=${this._hiddenPanel?.visible ?? false}`);
    }

    /**
     * Puts the language area in place, adopting the indicator that plays it.
     *
     * @returns {PanelMenu.Button|null} the language area, if there is one.
     */
    _placeLanguageArea() {
        if (!this._getSettings().get_boolean('language-area-enabled')) {
            this._releaseLanguageArea();
            return null;
        }

        // The input method panel of the session is the icon the input method
        // itself shows, the keyboard indicator of the shell is the fallback.
        const indicator = this._findIndicator(this._languageAreaRoles());

        if (indicator) {
            if (this._adoptedLanguageIndicator !== indicator) {
                this._releaseAdoptedLanguageArea();
                this._adoptLanguageArea(indicator);
            }

            this._applyIconSpacing(indicator);
            return indicator;
        }

        // Nothing to adopt: the shell has no input source indicator in this
        // session mode, so the language area is provided by us.
        this._releaseAdoptedLanguageArea();

        const ownIndicator = this._getOwnLanguageIndicator();

        if (ownIndicator)
            this._applyIconSpacing(ownIndicator);

        return ownIndicator;
    }

    /**
     * The panel roles that can play the language area, best first.
     *
     * An input method panel (kimpanel) shows the icon of the input method
     * itself, which is what the user means by "the input method icon" once
     * fcitx5 or ibus is running, so it is preferred over the keyboard
     * indicator of the shell. The preferences can pin one of them.
     *
     * @returns {string[]} the roles to look for, in the order to try them.
     */
    _languageAreaRoles() {
        const role = this._getSettings().get_string('language-area-role');

        if (role === IME_PANEL_ROLE || role === SHELL_LANGUAGE_AREA_ROLE)
            return [role];

        return [IME_PANEL_ROLE, SHELL_LANGUAGE_AREA_ROLE];
    }

    /**
     * @param {string[]} roles the panel roles to look for.
     * @returns {PanelMenu.Button|null} the first indicator of those roles that
     *   shows something, or the first one that is there at all.
     */
    _findIndicator(roles) {
        let hidden = null;

        for (const role of roles) {
            const indicator = Main.panel.statusArea[role];

            if (!indicator?.container)
                continue;

            if (indicator.container.visible)
                return indicator;

            hidden ??= indicator;
        }

        return hidden;
    }

    /**
     * Takes over an indicator that the shell or another extension put in the
     * panel, remembering where it was so that it can be handed back there.
     *
     * @param {PanelMenu.Button} indicator the indicator to adopt.
     */
    _adoptLanguageArea(indicator) {
        const {container} = indicator;
        const parent = container.get_parent();

        this._adoptedLanguageIndicator = indicator;
        this._adoptedLanguageHome = parent
            ? {parent, index: parent.get_children().indexOf(container)}
            : null;
        this._adoptedLanguageStyle = indicator.get_style();
    }

    /**
     * Hands the adopted indicator back to where it came from.
     */
    _releaseAdoptedLanguageArea() {
        const adopted = this._adoptedLanguageIndicator;

        if (!adopted)
            return;

        const home = this._adoptedLanguageHome;

        try {
            adopted.set_style(this._adoptedLanguageStyle ?? '');

            if (home?.parent)
                this._moveToBox(adopted.container, home.parent, home.index);
        } catch {
            // The indicator is gone with the panel item it lived in.
        }

        this._adoptedLanguageIndicator = null;
        this._adoptedLanguageHome = null;
        this._adoptedLanguageStyle = null;
    }

    /**
     * Creates the language area for the session modes that do not have an
     * input source indicator of their own.
     *
     * @returns {PanelMenu.Button|null} our own language area.
     */
    _getOwnLanguageIndicator() {
        if (this._ownLanguageIndicator)
            return this._ownLanguageIndicator;

        try {
            this._ownLanguageIndicator = new InputSourceIndicator();
            Main.panel.addToStatusArea(LANGUAGE_AREA_ROLE, this._ownLanguageIndicator,
                0, this.boxName);
        } catch (e) {
            this._ownLanguageIndicator = null;
            Util.Logger.warn(`Failed to create the language area: ${e}`);
        }

        return this._ownLanguageIndicator;
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
     * Puts the fold button between the language area and the tray icons.
     *
     * @returns {PanelMenu.Button} the fold button.
     */
    _placeFoldButton() {
        const foldButton = this._getFoldButton();

        // The button is only shown while there is something in the floating
        // panel, but its container stays in the panel either way: it is what
        // separates the tray area from the language area, see _syncIcons().
        foldButton.container.visible = this._hasHiddenIcons();
        foldButton.setRevealed(this._iconsExpanded);
        this._applyIconSpacing(foldButton);

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
        this._updateRowSpacing();

        // The spacing changes the width of the icons and of the fold button,
        // which is what the floating panel is aligned with.
        this._queuePanelReposition();
    }

    /**
     * Gives the rows of the grid the room the setting asks for.
     *
     * Half of the icon spacing, the way the horizontal spacing of the icons
     * falls on both of their sides: a row of the grid then reads the same as a
     * row of icons in the tray area.
     */
    _updateRowSpacing() {
        const gap = Math.round(getIconSpacing() / 2);
        const style = gap > 0 ? `margin-bottom: ${gap}px` : '';

        for (const row of this._panelRows) {
            if (row.get_style() !== style)
                row.set_style(style);
        }
    }

    /**
     * @returns {boolean} whether the user hid any icon.
     */
    _hasHiddenIcons() {
        return this._hiddenIcons.size > 0;
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

        const orderIndex = icon => order.get(icon.settingsId) ?? Number.MAX_SAFE_INTEGER;

        // Icons the user never dragged keep the order they showed up in.
        return allIcons.sort((a, b) =>
            orderIndex(a) - orderIndex(b) || positions.get(a) - positions.get(b));
    }

    /**
     * The icons that show something right now, in display order.
     *
     * An icon that is not ready yet, and an icon the app asked for to stay
     * hidden, shows nothing at all (see _updateVisibility() in
     * indicatorStatusIcon.js): it is part of neither the tray area nor the
     * floating panel, so it is not counted by either of them.
     *
     * @param {BaseStatusIcon[]} [icons] the icons to pick from, in display
     *     order.
     * @returns {BaseStatusIcon[]} the icons that show something.
     */
    _visibleIcons(icons = this._sortedIcons()) {
        return icons.filter(icon => icon.visible);
    }

    /**
     * Puts `actors` at the start of `box`, in that order.
     *
     * @param {St.BoxLayout} box the box to fill.
     * @param {(Clutter.Actor|null)[]} actors the actors, in the order they
     *   belong in; null entries are skipped.
     */
    _layoutGroup(box, actors) {
        let index = 0;

        for (const actor of actors) {
            if (!actor)
                continue;

            // The icon that is being dragged is placed by the drag itself.
            if (actor === this._drag?.icon.container) {
                index++;
                continue;
            }

            const parent = actor.get_parent();

            if (parent !== box) {
                if (parent)
                    parent.remove_child(actor);

                box.insert_child_at_index(actor,
                    Math.min(index, box.get_n_children()));
            } else if (box.get_children().indexOf(actor) !== index) {
                box.set_child_at_index(actor,
                    Math.min(index, box.get_n_children() - 1));
            }

            index++;
        }
    }

    /**
     * How many icons the floating panel shows in one row.
     *
     * @param {number} count the number of icons in the panel.
     * @returns {number} the number of columns.
     */
    _columnsForIconCount(count) {
        for (const [limit, columns] of PANEL_COLUMN_STEPS) {
            if (count < limit)
                return columns;
        }

        return MAX_PANEL_COLUMNS;
    }

    /**
     * Puts the icons the tray area does not show into the floating panel, in a
     * grid whose number of columns follows the number of icons.
     *
     * @param {BaseStatusIcon[]} icons the icons, in display order.
     * @param {BaseStatusIcon|null} [dragged] the icon that is being dragged, if
     *   the drag wants it laid out with the others instead of keeping it where
     *   it moves it to, see _previewIconInPanel().
     */
    _layoutPanelIcons(icons, dragged = null) {
        if (!icons.length) {
            this._clearPanelRows();
            return;
        }

        const columns = this._columnsForIconCount(icons.length);
        const rows = Math.ceil(icons.length / columns);

        this._getHiddenPanelBox();
        this._growPanelRows(rows);

        icons.forEach((icon, index) => {
            // The icon that is being dragged is placed by the drag itself,
            // unless the drag is showing it in the grid.
            if (icon === this._drag?.icon && icon !== dragged)
                return;

            const row = this._panelRows[Math.floor(index / columns)];
            const column = index % columns;
            const actor = icon.container;

            if (actor.get_parent() === row &&
                row.get_children().indexOf(actor) === column)
                return;

            if (actor.get_parent())
                actor.get_parent().remove_child(actor);

            row.insert_child_at_index(actor,
                Math.min(column, row.get_n_children()));
        });

        // The rows are trimmed only once the icons are placed: the ones that
        // live in a row that is not needed anymore had to move first.
        this._trimPanelRows(rows);
    }

    /**
     * @param {number} count the number of rows the panel needs.
     */
    _growPanelRows(count) {
        while (this._panelRows.length < count) {
            const row = new St.BoxLayout({
                style_class: 'appindicator-hidden-panel-row',
            });

            setBoxOrientation(row, false);
            this._hiddenPanelBox.add_child(row);
            this._panelRows.push(row);
            this._updateRowSpacing();
        }
    }

    /**
     * Removes the rows the panel does not need anymore.
     *
     * Every icon is either in the tray area or in one of the rows that are kept
     * by then, see _syncIcons(), so the rows that go are empty. A row that is
     * not empty is left alone anyway: destroying it would destroy the icon it
     * holds, and the icon that is being dragged may still be in it.
     *
     * @param {number} count the number of rows the panel needs.
     */
    _trimPanelRows(count) {
        while (this._panelRows.length > count) {
            const row = this._panelRows[this._panelRows.length - 1];

            if (row.get_n_children())
                break;

            this._panelRows.pop();
            row.destroy();
        }
    }

    _clearPanelRows() {
        this._trimPanelRows(0);
    }

    _updateIconOrder() {
        this._iconOrder = this._getSettings().get_strv('icon-order');
        this._syncIcons();
    }

    /**
     * Picks the icons the user hid up and moves them into the floating panel.
     * Whether the panel stays open is the user's state, see _syncIcons().
     */
    _updateHiddenIcons() {
        const wasEmpty = !this._hiddenIcons.size;

        this._hiddenIcons = new Set(this._getSettings().get_strv('hidden-icons'));

        if (!this._hiddenIcons.size) {
            // Nothing left to show, so collapse back.
            this._iconsExpanded = false;
        } else if (wasEmpty) {
            // The first icon that is hidden opens the panel it goes into. An
            // icon that disappears from the tray with nothing appearing
            // anywhere is what the feature not working looks like, so the panel
            // has to be seen once for the icon to be seen going somewhere.
            this._iconsExpanded = true;
        }

        this.relayout();
    }

    /**
     * @param {string} settingsId the id of an indicator.
     * @param {boolean} hidden whether it belongs into the floating panel.
     */
    _setIconHidden(settingsId, hidden) {
        const settings = this._getSettings();
        const hiddenIcons = new Set(settings.get_strv('hidden-icons'));
        const changed = hidden
            ? !hiddenIcons.has(settingsId) : hiddenIcons.delete(settingsId);

        if (!changed)
            return;

        if (hidden)
            hiddenIcons.add(settingsId);

        settings.set_strv('hidden-icons', [...hiddenIcons]);
    }

    /**
     * Publishes the icons we know about, so that the preferences can offer them
     * by name instead of asking for their id.
     */
    _publishKnownIcons() {
        const settings = this._getSettings();
        const knownIcons = [...this._trayIcons].map(icon =>
            [icon.settingsId, icon.displayName || icon.settingsId]);

        const value = new GLib.Variant('a(ss)', knownIcons);
        if (!settings.get_value('known-icons').equal(value))
            settings.set_value('known-icons', value);
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
                order.push(icon.settingsId);
        }

        for (const row of this._panelRows) {
            for (const child of row.get_children()) {
                const icon = this._iconForContainer(child);
                if (icon)
                    order.push(icon.settingsId);
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

    /**
     * Gives every area back: the adopted indicator to where it came from, our
     * own one out of the panel.
     */
    _releaseLanguageArea() {
        this._releaseAdoptedLanguageArea();

        if (!this._ownLanguageIndicator)
            return;

        Main.panel.statusArea[LANGUAGE_AREA_ROLE] = null;
        this._ownLanguageIndicator.destroy();
        this._ownLanguageIndicator = null;
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
     * @returns {St.BoxLayout} the box holding the grid of hidden icons.
     */
    _getHiddenPanelBox() {
        if (!this._hiddenPanel) {
            // No `spacing` here: GNOME 48 took that property off St.BoxLayout,
            // and a constructor argument the shell does not know throws, which
            // is enough to keep the panel from ever being built. The gap
            // between two rows is a margin on the rows instead, see
            // _updateRowSpacing().
            this._hiddenPanelBox = new St.BoxLayout({
                style_class: 'appindicator-hidden-panel',
            });
            setBoxOrientation(this._hiddenPanelBox, true);

            // The shell theme styles this class like a floating menu, so the
            // panel keeps the shape, the border and the shadow of a popup. Its
            // background is taken over from the bar, see
            // _applyPanelBackground().
            this._hiddenPanel = new St.Bin({
                style_class: 'popup-menu-content appindicator-hidden-panel-container',
                child: this._hiddenPanelBox,
                reactive: true,
                visible: false,
            });

            this._applyPanelBackground();
            Util.addActor(Main.uiGroup, this._hiddenPanel);
        }

        return this._hiddenPanelBox;
    }

    /**
     * Paints the floating panel with the background of the bar.
     *
     * The panel is a popup, so the theme gives it the color of a menu, which is
     * not the color of the bar it belongs to. The Windows notification area
     * keeps its flyout in the look of the taskbar, and so does this: the color
     * and the transparency of the bar are used as they are, only with a floor
     * so that the icons and the labels of a menu stay readable on a bar that
     * fades out completely.
     */
    _applyPanelBackground() {
        if (!this._hiddenPanel)
            return;

        const color = PanelBackground.PanelBackground.getDefault()?.color;
        const style = [PANEL_MIN_SIZE];

        // The panel is a popup, so the theme draws a border around it. It is
        // put next to the bar and follows its background, and the bar has no
        // border: the line only outlined the panel against the desktop.
        style.push('border-width: 0');

        // A bar that is not painted at all has no color to take over: the
        // panel keeps the look the theme gives a popup then, which is what it
        // had before a bar background was there to follow.
        if (color && color.alpha > 0) {
            const {red, green, blue} = color;
            const alpha = Math.max(color.alpha / 255, MIN_PANEL_ALPHA);

            // The theme paints the popup with a gradient of its own, which
            // would cover the color of the bar.
            style.push(`background-color: rgba(${red}, ${green}, ${blue}, ` +
                `${alpha.toFixed(3)})`);
            style.push('background-image: none');

            // The icons are symbolic: they are painted with the color of the
            // popup, which is the opposite of the bar they sit on now. Without
            // this the icons of a dark bar would be dark on dark.
            style.push(`color: ${isDarkColor(color) ? '#ffffff' : '#1a1a1a'}`);
        }

        // Keeps the panel usable as a drop target while it is empty.
        this._hiddenPanel.set_style(style.join('; '));
    }

    /**
     * Shows or hides the floating panel.
     */
    _updatePanel() {
        // The panel has to be there to be a drop target, empty or not.
        if (this._drag)
            this._getHiddenPanelBox();

        if (!this._hiddenPanel)
            return;

        const shouldShow = (this._iconsExpanded && this._hasHiddenIcons()) ||
            !!this._drag;

        this._hiddenPanel.visible = shouldShow;

        // The panel is in the group the shell lays its own things out in, and
        // whatever was added there after it — the background of the desktop,
        // the panel of another extension — paints over it. Being at the end of
        // the list is what a popup of its own would be.
        if (shouldShow) {
            this._hiddenPanel.get_parent()?.set_child_above_sibling(
                this._hiddenPanel, null);

            // The icon that is being dragged is above the panel as well: it is
            // carried over it, and the panel would paint over it otherwise.
            const clone = this._drag?.clone;
            clone?.get_parent()?.set_child_above_sibling(clone, null);

            this._updatePanelPosition();
        }
    }

    /**
     * Puts the floating panel next to the tray area, on the free side of the
     * panel bar: below a bar at the top of the screen, above one at the bottom,
     * right of one at the left edge and left of one at the right edge, so that
     * the panel never overlaps the bar, whatever its position and its size are.
     */
    _updatePanelPosition() {
        const panel = this._hiddenPanel;

        if (this._panelFrozen || !panel?.visible)
            return;

        const anchor = this._getHiddenPanelAnchor();
        const monitor = Main.layoutManager.primaryMonitor;

        if (!anchor || !monitor)
            return;

        const {x, y, width, height} = this._getGeometry(anchor);
        const bar = this._getBar();
        const [, panelWidth] = panel.get_preferred_width(-1);
        const [, panelHeight] = panel.get_preferred_height(-1);

        // Along the bar, the panel is aligned with the tray area, so that it
        // opens towards the icons it belongs to, the way the Windows flyout
        // does.
        const horizontal = !bar || bar.edge === 'top' || bar.edge === 'bottom';
        const anchorAtStart = !bar || (horizontal
            ? x + width / 2 < bar.x + bar.width / 2
            : y + height / 2 < bar.y + bar.height / 2);

        let wantedX;
        let wantedY;

        switch (bar?.edge) {
        case 'left':
            wantedX = bar.x + bar.width + PANEL_GAP;
            wantedY = anchorAtStart ? y : y + height - panelHeight;
            break;
        case 'right':
            wantedX = bar.x - PANEL_GAP - panelWidth;
            wantedY = anchorAtStart ? y : y + height - panelHeight;
            break;
        case 'bottom':
            wantedY = bar.y - PANEL_GAP - panelHeight;
            wantedX = anchorAtStart ? x : x + width - panelWidth;
            break;
        case 'top':
            wantedY = bar.y + bar.height + PANEL_GAP;
            wantedX = anchorAtStart ? x : x + width - panelWidth;
            break;
        default:
            // Without a bar to measure, the anchor is what the panel is put
            // next to, which is where the bar would have been.
            wantedX = x + width - panelWidth;
            wantedY = y + height + PANEL_GAP;
        }

        // The panel stays on the screen, even when it does not fit next to
        // the bar anymore.
        const minX = monitor.x + PANEL_GAP;
        const maxX = monitor.x + monitor.width - panelWidth - PANEL_GAP;
        const minY = monitor.y + PANEL_GAP;
        const maxY = monitor.y + monitor.height - panelHeight - PANEL_GAP;

        panel.set_position(
            Math.round(Math.min(Math.max(wantedX, minX), maxX)),
            Math.round(Math.min(Math.max(wantedY, minY), maxY)));
    }

    /**
     * The geometry of the panel bar and the side of the screen it is on.
     *
     * The bar is measured instead of taken for granted: the shell puts it at
     * the top of the screen, but the layouts of other desktops (Ubuntu's own
     * one, for instance) and the panel extensions move it to the bottom or to
     * one of the sides, and its size changes with the theme and with the icons
     * that are in it.
     *
     * @returns {{x: number, y: number, width: number, height: number,
     *   vertical: boolean, edge: string}|null} the bar and the side of the
     *   screen it is on, or null when it cannot be measured.
     */
    _getBar() {
        const monitor = Main.layoutManager.primaryMonitor;

        if (!monitor)
            return null;

        // The bar itself is what gets measured. The panel box that holds it is
        // the fallback for the moments where the bar has no size yet, e.g.
        // while the shell is still building the panel.
        let geometry = Main.panel ? this._getGeometry(Main.panel) : null;

        if (!geometry?.width || !geometry?.height)
            geometry = this._getGeometry(Main.layoutManager.panelBox);

        if (!geometry?.width || !geometry?.height)
            return null;

        const {x, y, width, height} = geometry;

        // A bar that is taller than it is wide is a bar at one of the sides,
        // whatever put it there. A bar whose middle is in the first half of
        // the screen is a bar at the top or at the left edge.
        const vertical = height > width;
        const centerX = x + width / 2;
        const centerY = y + height / 2;
        let edge;

        if (vertical)
            edge = centerX < monitor.x + monitor.width / 2 ? 'left' : 'right';
        else
            edge = centerY < monitor.y + monitor.height / 2 ? 'top' : 'bottom';

        return {x, y, width, height, vertical, edge};
    }

    /**
     * Repositions the floating panel once the icons had their say: their size
     * only changes after we are notified about the setting, so the panel is
     * moved on the next idle instead of right away.
     */
    _queuePanelReposition() {
        if (this._panelFrozen || !this._hiddenPanel?.visible ||
            this._repositionId)
            return;

        this._repositionId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._repositionId = 0;
            this._updatePanelPosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * The actor the floating panel is aligned with: the fold button, which is
     * the left end of the tray area while there is something to hide.
     *
     * @returns {Clutter.Actor|null} the actor to align with.
     */
    _getHiddenPanelAnchor() {
        const box = this._getBox();

        if (this._foldButton?.container.visible &&
            this._foldButton.container.get_parent() === box)
            return this._foldButton.container;

        for (const child of box.get_children()) {
            const icon = this._iconForContainer(child);
            if (icon?.visible)
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
     * inside the tray area, which is how the order of the icons is changed.
     *
     * Only the press is taken from the icon itself, everything that comes after
     * it is watched on the stage. An indicator that does not support activation
     * opens its menu on the press already (see vfunc_button_press_event() in
     * indicatorStatusIcon.js), and that menu grabs the pointer: the motion that
     * would turn the press into a drag is then delivered to the menu, never to
     * the icon, so a drag of such an icon could not start at all and the icon
     * stayed behind looking pressed. The stage sees the pointer no matter what
     * holds it, which is why the drag is run from there.
     *
     * @param {BaseStatusIcon} icon the icon to make draggable.
     */
    _setupDrag(icon) {
        if (this._dragHandlers.has(icon))
            return;

        const ids = [
            icon.connect('button-press-event',
                (_actor, event) => this._onButtonPress(icon, event)),
            icon.connect('destroy', () => this._teardownDrag(icon)),
        ];

        this._dragHandlers.set(icon, ids);
    }

    _teardownDrag(icon) {
        const ids = this._dragHandlers.get(icon);

        if (!ids)
            return;

        this._dragHandlers.delete(icon);

        if (this._press?.icon === icon)
            this._press = null;

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
        // here; the drag only starts once the pointer moved far enough, see
        // _onPointerMotion().
        this._watchPointer();

        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * Watches the pointer on the stage until the button is released again.
     */
    _watchPointer() {
        if (this._capturedEventId)
            return;

        this._capturedEventId = global.stage.connect('captured-event',
            (_stage, event) => this._onCapturedEvent(event));
    }

    _unwatchPointer() {
        if (!this._capturedEventId)
            return;

        global.stage.disconnect(this._capturedEventId);
        this._capturedEventId = 0;
    }

    /**
     * @param {Clutter.Event} event a pointer event, captured before it reaches
     *   whatever is under the pointer.
     * @returns {number} what the stage has to do with the event.
     */
    _onCapturedEvent(event) {
        switch (event.type()) {
        case Clutter.EventType.MOTION:
            return this._onPointerMotion(event);
        case Clutter.EventType.BUTTON_PRESS:
            // A press while an icon is being dragged is what a release that
            // never arrived leaves behind: the drag is given up instead of
            // being left running with the pointer, and the press is not handed
            // to the icon, whose menu would open on top of the drag.
            if (this._drag) {
                this._cancelDrag();
                this._press = null;
                return Clutter.EVENT_STOP;
            }

            this._press = null;
            return Clutter.EVENT_PROPAGATE;
        case Clutter.EventType.BUTTON_RELEASE: {
            if (this._drag) {
                this._finishDrag();
                this._unwatchPointer();
                return Clutter.EVENT_STOP;
            }

            this._press = null;

            // A drag that was cancelled with Escape is still under the button
            // that started it: the release belongs to the drag, not to the
            // icon, and must not open its menu.
            const swallow = this._swallowRelease;
            this._swallowRelease = false;
            this._unwatchPointer();

            return swallow ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }
        case Clutter.EventType.KEY_PRESS:
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;

            if (this._drag) {
                this._cancelDrag();
                this._swallowRelease = true;
                return Clutter.EVENT_STOP;
            }

            // Escape gives up a press that has not turned into a drag: the
            // release that follows is not a click on the icon anymore.
            if (this._press) {
                this._press = null;
                this._swallowRelease = true;
            }

            this._unwatchPointer();
            return Clutter.EVENT_PROPAGATE;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    /**
     * @param {Clutter.Event} event a pointer motion event.
     * @returns {number} what the stage has to do with the event.
     */
    _onPointerMotion(event) {
        const [x, y] = event.get_coords();

        if (this._drag) {
            this._moveDrag(x, y);
            return Clutter.EVENT_STOP;
        }

        const press = this._press;

        if (!press || !this._trayIcons.has(press.icon))
            return Clutter.EVENT_PROPAGATE;

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

        // The press already reached the icon, and an indicator that has no
        // activation opens its menu on it: the menu grabbed the pointer, which
        // is why the drag is run from the stage, and it has to go before the
        // icon can be dragged. The icon must not keep looking pressed either.
        icon.cancelPendingClicks();
        icon.menu?.close();
        icon.remove_style_pseudo_class('active');

        const [containerX, containerY] = container.get_transformed_position();

        const clone = new Clutter.Clone({source: container});
        clone.opacity = 200;
        clone.set_position(Math.round(x - (press.x - containerX)),
            Math.round(y - (press.y - containerY)));

        // The icon itself stays where it is, dimmed, the clone follows the
        // pointer and the icon moves when the pointer reaches its new place.
        container.opacity = 100;

        this._drag = {
            icon,
            clone,
            offsetX: press.x - containerX,
            offsetY: press.y - containerY,
        };

        // The panel has to be there to be a drop target, empty or not. It is
        // shown before the clone is put on the stage, because showing it raises
        // it above everything else that lives there.
        this._updatePanel();
        Util.addActor(Main.uiGroup, clone);
        this._logState('drag started');

        // It is put in place once and then stays where it is: moving it along
        // with its contents would move the drop target out from under the
        // pointer as soon as an icon lands in it.
        this._panelFrozen = true;
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
            this._previewIconInPanel(icon, x, y);
            return;
        }

        if (!this._isPointInside(Main.panel, x, y))
            return;

        const box = this._getBox();
        const segment = this._getTraySegment(box);

        if (!segment)
            return;

        // The icons only live in the tray part of the block: the language area
        // and the fold button keep the place they are put in.
        if (!this._isInTraySegment(segment, x, y))
            return;

        // The icon comes back out of the panel: the icons that stay behind
        // close the gap it leaves there.
        const wasInPanel = this._isIconInHiddenPanel(icon);
        const anchor = this._findDropAnchor(segment, x, y, icon.container);

        this._moveActorAfter(icon.container, box, anchor);

        if (wasInPanel)
            this._layoutPanelIcons(this._hiddenIconsForPanel(icon));
    }

    /**
     * @param {BaseStatusIcon} icon an icon.
     * @returns {BaseStatusIcon[]} the icons the floating panel holds, in display
     *   order, without the one that is given.
     */
    _hiddenIconsForPanel(icon) {
        return this._visibleIcons().filter(other =>
            other !== icon && this._hiddenIcons.has(other.settingsId));
    }

    /**
     * Puts the dragged icon into the grid of the floating panel, at the place
     * the pointer is over, so that the panel shows where the icon will land.
     *
     * The icon itself is moved there and not just drawn there: what the drag
     * asks on release is whether the icon is in the panel or not, and that is
     * where the icon is, see _finishDrag().
     *
     * @param {BaseStatusIcon} icon the icon that is being dragged.
     * @param {number} x the pointer position.
     * @param {number} y the pointer position.
     */
    _previewIconInPanel(icon, x, y) {
        const others = this._hiddenIconsForPanel(icon);
        const index = this._panelDropIndex(icon, x, y);
        const icons = [...others];

        icons.splice(Math.min(index, icons.length), 0, icon);
        this._layoutPanelIcons(icons, icon);
    }

    /**
     * Where in the grid of the floating panel the pointer is.
     *
     * @param {BaseStatusIcon} icon the icon that is being dragged.
     * @param {number} x the pointer position.
     * @param {number} y the pointer position.
     * @returns {number} the index the icon would be inserted at, counted among
     *   the icons the panel holds without it.
     */
    _panelDropIndex(icon, x, y) {
        let index = 0;
        let nearest = Infinity;
        let position = 0;

        for (const row of this._panelRows) {
            for (const child of row.get_children()) {
                const other = this._iconForContainer(child);

                if (!other || other === icon || !other.visible)
                    continue;

                const geometry = this._getGeometry(child);
                const centerX = geometry.x + geometry.width / 2;
                const centerY = geometry.y + geometry.height / 2;
                const distance = (x - centerX) ** 2 + (y - centerY) ** 2;

                // The icon goes before the cell the pointer is left of and
                // after the one it is right of, so that it lands where the
                // pointer is rather than always at the end of the grid.
                if (distance < nearest) {
                    nearest = distance;
                    index = position + (x < centerX ? 0 : 1);
                }

                position += 1;
            }
        }

        return index;
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

    /**
     * @param {BaseStatusIcon} icon an icon, if there is one.
     * @returns {boolean} whether the icon is currently in the floating panel.
     */
    _isIconInHiddenPanel(icon) {
        return !!icon &&
            this._panelRows.some(row => icon.container.get_parent() === row);
    }

    /**
     * The children of `box` the tray icons live in and the fold button that
     * bounds them.
     *
     * The tray icons are only ever rearranged among themselves: the language
     * area and the fold button stay where _syncIcons() put them, so the icons
     * may neither be dragged in front of the language area nor across the fold
     * button, which is what keeps them apart.
     *
     * @param {St.BoxLayout} box the box the tray area is in.
     * @returns {{children: Clutter.Actor[], boundary: Clutter.Actor,
     *   afterBoundary: boolean, vertical: boolean}|null} the segment, or null
     *   when there is no fold button to measure it with.
     */
    _getTraySegment(box) {
        const boundary = this._getFoldButtonContainer(box);

        if (!boundary)
            return null;

        const children = box.get_children();
        const boundaryIndex = children.indexOf(boundary);
        const afterBoundary = this._imeBeforeTray;

        return {
            children: afterBoundary
                ? children.slice(boundaryIndex + 1)
                : children.slice(0, boundaryIndex),
            boundary,
            afterBoundary,
            vertical: isVerticalBox(box),
        };
    }

    /**
     * @param {{boundary: Clutter.Actor, afterBoundary: boolean,
     *   vertical: boolean}} segment the tray segment.
     * @param {number} x the pointer position.
     * @param {number} y the pointer position.
     * @returns {boolean} whether the pointer is on the side of the fold button
     *   the tray icons are.
     */
    _isInTraySegment(segment, x, y) {
        const {boundary, afterBoundary, vertical} = segment;

        // A hidden fold button takes no room and is not allocated, so there is
        // nothing to measure the segment against. The drop anchor still keeps
        // the icons on their side of it, see _findDropAnchor().
        if (!boundary.visible)
            return true;

        const geometry = this._getGeometry(boundary);
        const pointer = vertical ? y : x;
        const start = vertical ? geometry.y : geometry.x;

        return afterBoundary
            ? pointer >= start + (vertical ? geometry.height : geometry.width)
            : pointer <= start;
    }

    /**
     * The icon the dragged one has to be placed after so that it lands under
     * the pointer. Only the icons of the segment that are shown are taken into
     * account, the language area, the fold button, the icons that show nothing
     * and the other panel items keep their place.
     *
     * @param {{children: Clutter.Actor[], boundary: Clutter.Actor,
     *   afterBoundary: boolean, vertical: boolean}} segment the tray segment.
     * @param {number} x the pointer position.
     * @param {number} y the pointer position.
     * @param {Clutter.Actor} dragged the container that is being moved.
     * @returns {Clutter.Actor|null} what to place the icon after.
     */
    _findDropAnchor(segment, x, y, dragged) {
        const {children, boundary, afterBoundary, vertical} = segment;
        const pointer = vertical ? y : x;

        // The fold button is where the tray icons start, so an icon that is
        // dropped in front of the first one follows the button, not the
        // language area.
        let anchor = afterBoundary ? boundary : null;

        for (const child of children) {
            const icon = this._iconForContainer(child);

            // The icons that show nothing are not on the panel, so they cannot
            // be aimed at: dropping on them would hide the icon that is being
            // dragged.
            if (child === dragged || !icon || !child.visible)
                continue;

            const geometry = this._getGeometry(child);
            const start = vertical ? geometry.y : geometry.x;
            const size = vertical ? geometry.height : geometry.width;

            if (pointer < start + size / 2)
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
        this._setIconHidden(icon.settingsId, inPanel);
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

        // The icon may have been destroyed while it was being dragged.
        if (this._trayIcons.has(drag.icon))
            drag.icon.container.opacity = 255;

        drag.clone.destroy();

        // The panel was only shown to be a drop target.
        this._updatePanel();
        this._logState('drag stopped');
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
        this._unwatchPointer();

        if (this._repositionId) {
            GLib.source_remove(this._repositionId);
            this._repositionId = 0;
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

            if (box) {
                for (const row of this._panelRows) {
                    for (const child of [...row.get_children()])
                        Util.addActor(box, child);
                }
            }

            this._hiddenPanel.destroy();
            this._hiddenPanel = null;
            this._hiddenPanelBox = null;
            this._panelRows = [];
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
