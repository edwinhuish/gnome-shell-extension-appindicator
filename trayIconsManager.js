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
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import * as IndicatorStatusIcon from './indicatorStatusIcon.js';
import * as PanelBackground from './panelBackground.js';
import * as Util from './util.js';
import * as SettingsManager from './settingsManager.js';

let trayIconsManager;

export class TrayIconsManager extends Signals.EventEmitter {
    static initialize() {
        if (!trayIconsManager)
            trayIconsManager = new TrayIconsManager();
        return trayIconsManager;
    }

    static destroy() {
        trayIconsManager.destroy();
    }

    constructor() {
        super();

        if (trayIconsManager)
            throw new Error('TrayIconsManager is already constructed');

        this._changedId = SettingsManager.getDefaultGSettings().connect(
            'changed::legacy-tray-enabled', () => this._toggle());

        // The list of ignored window classes is read when an icon is added, so
        // a new entry only has to be applied to the icons already on the panel.
        this._ignoredId = SettingsManager.getDefaultGSettings().connect(
            'changed::hidden-legacy-icons', () => this._syncIgnoredIcons());

        // The tray icons that are kept off the panel right now, by the icon
        // window they wrap: they are what makes the icons appear again as soon
        // as their window class leaves hidden-legacy-icons.
        this._ignoredIcons = new Map();

        // The background of the bar is handed to the tray manager when it is
        // built, see _enable(), and it has to be kept in sync with the bar.
        // The tray manager is rebuilt for that, so it is done once the bar
        // stopped changing instead of on every step of an animation.
        this._background = PanelBackground.PanelBackground.initialize();
        Util.connectSmart(this._background, 'settled', this,
            () => this._syncBackground());

        // The color the running tray manager was built with, and the guard
        // and the idle source of the rebuild.
        this._trayColor = null;
        this._syncing = false;
        this._restartId = 0;

        this._toggle();
    }

    _toggle() {
        if (SettingsManager.getDefaultGSettings().get_boolean('legacy-tray-enabled'))
            this._enable();
        else
            this._disable();
    }

    /**
     * The background the X11 tray icons are painted on.
     *
     * Legacy tray icons do not have to be RGBA, in which case the shell paints
     * the background of the bar behind them instead of showing whatever the
     * icon left there. It is the color the tray area is painted with (the bar's
     * own one, or the one the user set when the bar has none to give), so that
     * the icons sit in the tray like they do in the Windows notification area.
     *
     * @returns {{red: number, green: number, blue: number, alpha: number}|null}
     *   the color, as the tray background reports it.
     */
    _getPanelBgColor() {
        return this._background?.color ?? null;
    }

    _enable() {
        if (this._tray)
            return;

        this._trayColor = this._getPanelBgColor();
        this._tray = new Shell.TrayManager({
            bgColor: PanelBackground.PanelBackground.getDefault()?.themeColor ?? null,
        });
        Util.connectSmart(this._tray, 'tray-icon-added', this, this.onTrayIconAdded);
        Util.connectSmart(this._tray, 'tray-icon-removed', this, this.onTrayIconRemoved);

        this._tray.manage_screen(Main.panel);
    }

    _disable() {
        if (!this._tray)
            return;

        IndicatorStatusIcon.getTrayIcons().forEach(i => i.destroy());
        this._tray.unmanage_screen();
        this._tray = null;
        this._trayColor = null;

        // The icons are gone with the tray manager, and so are the windows the
        // ignored ones were kept for.
        this._ignoredIcons.clear();
    }

    /**
     * Rebuilds the tray manager when the bar changed its color.
     *
     * The background color of the tray manager is a construct-only property,
     * so the only way to give the icons another background is to build the
     * manager again: the icons are destroyed with the old one and the
     * applications add them back to the new one.
     *
     * That is why this only happens when the color of the bar really changed.
     * A bar that only changes its transparency (dash-to-panel's dynamic
     * transparency, for instance) is left alone: its alpha is not part of the
     * background the icons are painted on (an X11 icon without an alpha
     * channel has no transparency to be painted into), and rebuilding the
     * whole tray area on every fade would make every legacy icon blink.
     */
    _syncBackground() {
        if (!this._tray || this._syncing)
            return;

        const color = this._getPanelBgColor();

        if (TrayIconsManager.sameRgb(color, this._trayColor))
            return;

        // Rebuilding the tray manager while the session is locked or the shell
        // is still starting up is what made older versions of this extension
        // crash: there is no panel to put the icons back into at that point.
        if (Main.sessionMode.isLocked || Main.layoutManager._startingUp)
            return;

        this._restartId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._restartId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuild() {
        if (!this._tray)
            return;

        this._syncing = true;

        try {
            this._disable();
            this._enable();
        } finally {
            this._syncing = false;
        }
    }

    /**
     * @param {object|null} a a color of the tray background.
     * @param {object|null} b another color of the tray background.
     * @returns {boolean} whether both paint the same, transparency aside.
     */
    static sameRgb(a, b) {
        if (!a || !b)
            return a === b;

        return a.red === b.red && a.green === b.green && a.blue === b.blue;
    }

    onTrayIconAdded(_tray, icon) {
        const trayIcon = new IndicatorStatusIcon.IndicatorStatusTrayIcon(icon);

        if (this._isIgnored(icon)) {
            this._ignoreIcon(trayIcon, icon);
            return;
        }

        IndicatorStatusIcon.addIconToPanel(trayIcon);
    }

    /**
     * Puts a legacy tray icon on the panel.
     *
     * @param {object} icon the icon the tray manager added.
     */
    _addIconToPanel(icon) {
        const trayIcon = new IndicatorStatusIcon.IndicatorStatusTrayIcon(icon);
        IndicatorStatusIcon.addIconToPanel(trayIcon);
    }

    /**
     * Takes a legacy tray icon off the panel but keeps the icon itself alive.
     *
     * The window stays managed by the tray manager, so the application still
     * has its icon and knows nothing about this; the icon is kept here, so that
     * it can be put back on the panel without the application adding it again.
     *
     * Destroying the container would destroy the icon it wraps as well (see
     * _onDestroy() in indicatorStatusIcon.js), so the icon is detached from the
     * container first. That is the one place where an icon is taken out of its
     * container by hand.
     *
     * @param {object} trayIcon the container that was built for the icon.
     * @param {object} icon the icon the tray manager added.
     */
    _ignoreIcon(trayIcon, icon) {
        Util.Logger.debug(`Ignoring legacy tray icon ${icon.wm_class}`);

        const parent = icon.get_parent();
        if (parent)
            parent.remove_child(icon);

        trayIcon._icon = null;
        trayIcon.destroy();

        this._ignoredIcons.set(icon, true);
    }

    /**
     * Whether the window class of this tray icon is listed in
     * `hidden-legacy-icons`, the applications whose own tray icon is not
     * wanted (see the description of the key).
     *
     * @param {object} icon the icon the tray manager added.
     * @returns {boolean} whether it has to be kept off the panel.
     */
    _isIgnored(icon) {
        const patterns = SettingsManager.getDefaultGSettings()
            .get_strv('hidden-legacy-icons');

        if (!patterns.length)
            return false;

        const wmClass = `${icon.wm_class ?? ''}`.trim().toLowerCase();
        const pidId = `legacy:pid:${icon.pid}`;

        return patterns.some(pattern => {
            const value = pattern.trim().toLowerCase();

            return value !== '' && (value === wmClass ||
                value === `legacy:${wmClass}` || value === pidId);
        });
    }

    /**
     * Applies `hidden-legacy-icons` to the icons that are already there: the
     * ones that are now listed are taken off the panel, the ones that are not
     * listed any more are put back. Both work without the application having to
     * add its icon again, which is what makes the setting switchable.
     */
    _syncIgnoredIcons() {
        for (const trayIcon of IndicatorStatusIcon.getTrayIcons()) {
            if (trayIcon.icon && this._isIgnored(trayIcon.icon))
                this._ignoreIcon(trayIcon, trayIcon.icon);
        }

        for (const icon of [...this._ignoredIcons.keys()]) {
            if (this._isIgnored(icon))
                continue;

            this._ignoredIcons.delete(icon);
            this._addIconToPanel(icon);
        }
    }

    onTrayIconRemoved(_tray, icon) {
        this._ignoredIcons.delete(icon);

        try {
            const [trayIcon] = IndicatorStatusIcon.getTrayIcons().filter(i => i.icon === icon);
            trayIcon.destroy();
        } catch (e) {
            Util.Logger.warn(`No icon container found for ${icon.title} (${icon}): ${e}`);
        }
    }

    destroy() {
        this.emit('destroy');

        if (this._restartId) {
            GLib.source_remove(this._restartId);
            this._restartId = 0;
        }

        SettingsManager.getDefaultGSettings().disconnect(this._changedId);
        SettingsManager.getDefaultGSettings().disconnect(this._ignoredId);
        this._disable();
        trayIconsManager = null;
    }
}
