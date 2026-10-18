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

import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import * as SettingsManager from './settingsManager.js';
import * as Util from './util.js';

/**
 * Time without another change after which the background of the bar counts as
 * settled, in milliseconds.
 *
 * Panel bars are animated: dash-to-panel, for instance, fades the bar in and
 * out in a dozen steps when a window is maximized. Everything that can follow
 * the animation (the floating panel of the hidden icons, for instance) is
 * updated right away, but everything that can only be applied by rebuilding
 * an actor waits for the animation to be over.
 */
const SETTLE_TIMEOUT = 250;

const SETTINGS = {
    MODE: 'panel-background-mode',
    COLOR: 'panel-background-color',
    OPACITY: 'panel-background-opacity',
};

const MODE = {
    AUTO: 'auto',
    CUSTOM: 'custom',
};

let panelBackground;

/**
 * The background of the panel bar, i.e. the thing the tray sits in.
 *
 * The color of the bar is read from its theme node, which is also where the
 * inline style of panel extensions ends up: a bar that paints itself with a
 * color of its own (dash-to-panel's transparency settings, for instance) is
 * reported with that color and that transparency, not with the color of the
 * shell theme. The actor opacity of the bar and of the panel box is applied on
 * top of it, so that a bar the shell fades out reports the color it is painted
 * with at that moment.
 *
 * That is not always possible: a theme may paint the bar with an image, a panel
 * extension may draw its own background, and a bar may be faded out completely,
 * in which case there is no color to take over. The color and the transparency
 * the user set are used then, and they are what the tray area is painted with
 * when the user asked for them to be used all the time, see the
 * "panel-background-mode" setting.
 *
 * Two signals are emitted:
 *
 * - `changed` right away, whenever the effective color changed. Anything that
 *   only paints something follows the bar without a visible delay.
 * - `settled` once the color stayed the same for SETTLE_TIMEOUT. Anything that
 *   has to rebuild an actor to pick the color up listens to this one, so that
 *   an animation does not make it rebuild over and over again.
 */
export class PanelBackground extends Signals.EventEmitter {
    static initialize() {
        panelBackground ??= new PanelBackground();
        return panelBackground;
    }

    static destroy() {
        panelBackground?.destroy();
        panelBackground = null;
    }

    static getDefault() {
        return panelBackground;
    }

    constructor() {
        super();

        if (panelBackground)
            throw new Error('PanelBackground is already constructed');

        // The color the tray is painted with, its transparency included, and
        // the very object the theme node handed out, which is what
        // Shell.TrayManager takes.
        this._color = null;
        this._themeColor = null;

        // The color of the bar itself, kept aside: it is not what is painted
        // with while the configured color is the one in use.
        this._panelThemeColor = null;

        // Whether the configured color is the one in use, and the guard of the
        // note that says why, which is worth writing once, not once per fade.
        this._usingCustom = false;
        this._fallbackWarned = false;

        this._settleId = 0;
        this._settledColor = null;

        this._connectSources();
        this.update();
    }

    /**
     * @returns {{red: number, green: number, blue: number, alpha: number}|null}
     *   the background of the bar, channels and alpha in 0..255, or null when
     *   there is no background to paint at all.
     */
    get color() {
        return this._color;
    }

    /**
     * The background as a CSS color, `null` when it is not known.
     *
     * The alpha is part of it: a bar that is half transparent gives a color
     * that paints exactly like the bar does.
     */
    get cssColor() {
        if (!this._color)
            return null;

        const {red, green, blue, alpha} = this._color;
        return `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})`;
    }

    /**
     * The color object of the theme node of the bar, as Shell.TrayManager
     * wants it for the background of the X11 tray icons. It carries the
     * transparency of the bar, but not its actor opacity: an actor that is
     * faded out fades its children out as well, so that one is applied twice
     * otherwise.
     */
    get themeColor() {
        return this._themeColor;
    }

    /**
     * @returns {boolean} whether the tray is painted with the color of the bar
     *   rather than with the color the user set.
     */
    get followsPanel() {
        return !this._usingCustom;
    }

    _connectSources() {
        // The bar paints its background with a style of its own, so a style
        // change is what a new color and a new transparency show up as.
        const {panel} = Main;
        const {panelBox} = Main.layoutManager;

        for (const actor of [panel, panelBox]) {
            if (!actor)
                continue;

            Util.connectSmart(actor, 'style-changed', this, () => this.update());
            Util.connectSmart(actor, 'notify::opacity', this, () => this.update());
        }

        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        Util.connectSmart(themeContext, 'changed', this, () => this.update());
        Util.connectSmart(Main.sessionMode, 'updated', this, () => this.update());
        Util.connectSmart(Main.layoutManager, 'monitors-changed', this,
            () => this.update());

        const settings = this._getSettings();
        if (settings) {
            for (const key of Object.values(SETTINGS)) {
                Util.connectSmart(settings, `changed::${key}`, this,
                    () => this.update());
            }
        }
    }

    /**
     * Reads the background the tray is painted with and tells about it.
     */
    update() {
        const panelColor = this._readPanelColor();
        const customColor = this._readCustomColor();
        const custom = this._getMode() === MODE.CUSTOM;

        // A bar that has no color to report (a theme that paints it with an
        // image, a panel extension drawing its own background, a bar faded out
        // completely, ...) leaves nothing to follow, so what the user set is
        // used instead: the tray area and the floating panel are never left
        // without a background of their own.
        const fallback = !custom && (!panelColor || panelColor.alpha === 0);
        const usingCustom = custom || fallback;
        const color = usingCustom ? customColor : panelColor;

        // Only worth a note when the color the user set is what the tray ends
        // up being painted with, and only once for that reason.
        if (fallback && customColor) {
            if (!this._fallbackWarned)
                Util.Logger.debug('The panel bar reports no background, using the configured one');

            this._fallbackWarned = true;
        } else if (!fallback) {
            this._fallbackWarned = false;
        }

        if (PanelBackground.sameColor(this._color, color) &&
            usingCustom === this._usingCustom)
            return;

        this._usingCustom = usingCustom;

        // The color of the bar is handed out as the theme node gave it, the
        // configured one has to be built, it is the color itself (an X11 icon
        // has no transparency to be painted into, so is its alpha).
        if (usingCustom)
            this._themeColor = customColor ? this._buildThemeColor(customColor) : null;
        else
            this._themeColor = panelColor ? this._panelThemeColor : null;

        this._color = color;
        this.emit('changed');
        this._queueSettled();
    }

    /**
     * @returns {object|null} the color the bar paints itself with, transparency
     *   taken from the actor opacity as well, or null when it has none.
     */
    _readPanelColor() {
        this._panelThemeColor =
            Main.panel?.get_theme_node()?.get_background_color() ?? null;

        if (!this._panelThemeColor)
            return null;

        const opacity = this._opacity();

        return {
            red: PanelBackground.toChannel(this._panelThemeColor.red),
            green: PanelBackground.toChannel(this._panelThemeColor.green),
            blue: PanelBackground.toChannel(this._panelThemeColor.blue),
            alpha: Math.round(
                PanelBackground.toChannel(this._panelThemeColor.alpha) * opacity),
        };
    }

    /**
     * @returns {object|null} the color the user set, or null when there is none
     *   to read (no settings yet, unparsable value, ...).
     */
    _readCustomColor() {
        const settings = this._getSettings();

        if (!settings)
            return null;

        const color = PanelBackground.parseColor(
            settings.get_string(SETTINGS.COLOR));

        if (!color)
            return null;

        const percent = Math.min(
            Math.max(settings.get_int(SETTINGS.OPACITY), 0), 100);

        return {...color, alpha: Math.round(255 * percent / 100)};
    }

    /**
     * @returns {string} the mode the tray background is picked in.
     */
    _getMode() {
        return this._getSettings()?.get_string(SETTINGS.MODE) ?? MODE.AUTO;
    }

    _getSettings() {
        try {
            return SettingsManager.getDefaultGSettings();
        } catch {
            // The background is read before the settings are there when the
            // extension is loaded, the next update picks them up.
            return null;
        }
    }

    /**
     * Builds the color object Shell.TrayManager wants out of a plain color.
     *
     * Its type is not the same on every shell: it is a ClutterColor on older
     * ones and a CoglColor on newer ones. What the theme node of the bar hands
     * out is a color of exactly that type, so it is used as the model to build
     * the configured color with.
     *
     * @param {{red: number, green: number, blue: number}} color a color.
     * @returns {object|null} the color, or null when it cannot be built.
     */
    _buildThemeColor({red, green, blue}) {
        const Color = this._panelThemeColor?.constructor;

        if (typeof Color?.from_string !== 'function') {
            Util.Logger.debug('The panel bar reports no color type to build a background with');
            return null;
        }

        try {
            const [ok, color] = Color.from_string(
                `rgba(${red}, ${green}, ${blue}, 1)`);

            if (ok)
                return color;
        } catch (e) {
            Util.Logger.warn(`Failed to build the tray background color: ${e}`);
        }

        return null;
    }

    /**
     * The opacity of the bar itself, as a factor in 0..1.
     *
     * It is the opacity of the bar and of the box it lives in, because both
     * are faded by the shell and by the panel extensions that animate them.
     *
     * @returns {number} the factor the background color is painted with.
     */
    _opacity() {
        let opacity = 1;

        for (const actor of [Main.panel, Main.layoutManager.panelBox]) {
            if (actor && actor.opacity < 255)
                opacity *= actor.opacity / 255;
        }

        return opacity;
    }

    /**
     * Emits `settled` once the color stopped changing, see SETTLE_TIMEOUT.
     */
    _queueSettled() {
        if (this._settleId)
            GLib.source_remove(this._settleId);

        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_TIMEOUT,
            () => {
                this._settleId = 0;

                if (PanelBackground.sameColor(this._settledColor, this._color)) {
                    this._settledColor = this._color;
                    return GLib.SOURCE_REMOVE;
                }

                this._settledColor = this._color;
                this.emit('settled');
                return GLib.SOURCE_REMOVE;
            });
    }

    /**
     * A color channel in 0..255.
     *
     * St hands the color out as CoglColor on newer shells, whose channels are
     * floats in 0..1, and as ClutterColor on older ones, whose channels are
     * bytes already.
     *
     * @param {number} value the channel as the theme node reports it.
     * @returns {number} the channel in 0..255.
     */
    static toChannel(value) {
        const channel = value <= 1 ? Math.round(value * 255) : Math.round(value);
        return Math.min(Math.max(channel, 0), 255);
    }

    /**
     * Reads a color out of what is stored in the settings: `#rgb`, `#rrggbb`,
     * `#rrggbbaa`, `rgb(...)` or `rgba(...)`, the way a color picker writes
     * them.
     *
     * The alpha is not part of what is returned, the transparency of the tray
     * background is a setting of its own.
     *
     * @param {string} value the stored color.
     * @returns {{red: number, green: number, blue: number}|null} the color, or
     *   null when the value is none.
     */
    static parseColor(value) {
        const text = `${value ?? ''}`.trim();

        const hex = text.match(/^#([0-9a-f]{3,8})$/i);
        if (hex) {
            const [, digits] = hex;

            if (digits.length === 3) {
                return {
                    red: parseInt(digits[0].repeat(2), 16),
                    green: parseInt(digits[1].repeat(2), 16),
                    blue: parseInt(digits[2].repeat(2), 16),
                };
            }

            if (digits.length === 6 || digits.length === 8) {
                return {
                    red: parseInt(digits.slice(0, 2), 16),
                    green: parseInt(digits.slice(2, 4), 16),
                    blue: parseInt(digits.slice(4, 6), 16),
                };
            }

            return null;
        }

        const functional = text.match(
            /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/i);

        if (!functional)
            return null;

        const [, red, green, blue] = functional;
        const channel = input => Math.min(Math.max(parseInt(input, 10), 0), 255);

        return {
            red: channel(red),
            green: channel(green),
            blue: channel(blue),
        };
    }

    /**
     * @param {object|null} a a color.
     * @param {object|null} b another color.
     * @returns {boolean} whether both are the same, null included.
     */
    static sameColor(a, b) {
        if (!a || !b)
            return a === b;

        return a.red === b.red && a.green === b.green &&
            a.blue === b.blue && a.alpha === b.alpha;
    }

    destroy() {
        this.emit('destroy');

        if (this._settleId) {
            GLib.source_remove(this._settleId);
            this._settleId = 0;
        }

        this._color = null;
        this._themeColor = null;
        this._settledColor = null;
        panelBackground = null;
    }
}
