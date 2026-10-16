/* exported HiddenIconPage */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export var HiddenIconPage = GObject.registerClass(
class AppIndicatorHiddenIconPage extends Adw.PreferencesPage {
    _init(settings, settingsKey) {
        super._init({
            title: _('Hidden Icons'),
            icon_name: 'view-conceal-symbolic',
            name: 'Hidden Icons Page',
        });

        this._settings = settings;
        this._settingsKey = settingsKey;
        this._rebuilding = false;
        this._rows = [];

        this._group = new Adw.PreferencesGroup({
            title: _('Tray Icons'),
            description: _('Icons that are collected in the floating panel next ' +
                'to the panel bar, instead of the tray area: it opens below the ' +
                'bar when the bar is at the top of the screen and above the bar ' +
                'when the bar is at the bottom. Use the fold button in the panel ' +
                'to show and hide it, or drag an icon onto the panel.'),
        });

        this._entryGroup = new Adw.PreferencesGroup({
            title: _('Add by Indicator ID'),
        });

        this.add(this._group);
        this.add(this._entryGroup);

        this._buildEntryRow();
        this._rebuildRows();

        this._settings.connect('changed::known-icons', () => this._queueRebuild());
        this._settings.connect('changed::hidden-icons', () => this._queueRebuild());
    }

    _buildEntryRow() {
        this._entry = new Gtk.Entry({
            hexpand: true,
            valign: Gtk.Align.CENTER,
            placeholder_text: _('Indicator ID'),
        });
        this._entry.connect('activate', () => this._addEntry());

        const addButton = new Gtk.Button({
            label: _('Add'),
            valign: Gtk.Align.CENTER,
        });
        addButton.add_css_class('flat');
        addButton.connect('clicked', () => this._addEntry());

        const row = new Adw.ActionRow({title: _('Indicator ID')});
        row.add_suffix(this._entry);
        row.add_suffix(addButton);

        this._entryGroup.add(row);
    }

    _addEntry() {
        const id = this._entry.get_text().trim();

        if (!id)
            return;

        this._setHidden(id, true);
        this._entry.set_text('');
    }

    /**
     * Rebuild the list of icons, but never while a row is emitting a signal,
     * since that would tear down the widget we are being called from.
     */
    _queueRebuild() {
        if (this._rebuildId)
            return;

        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            delete this._rebuildId;
            this._rebuildRows();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuildRows() {
        if (this._rebuilding)
            return;

        this._rebuilding = true;

        try {
            for (const row of this._rows)
                this._group.remove(row);

            this._rows = [];

            const hiddenIcons = new Set(
                this._settings.get_strv(this._settingsKey.HIDDEN_ICONS));
            const knownIcons = this._settings.get_value(
                this._settingsKey.KNOWN_ICONS).deep_unpack();

            const listed = new Set();

            for (const [id, name] of knownIcons) {
                listed.add(id);
                this._addRow(this._createRow(id, name, hiddenIcons.has(id)));
            }

            // Keep the entries of icons that are not running right now around,
            // so that they can still be un-hidden.
            for (const id of hiddenIcons) {
                if (!listed.has(id))
                    this._addRow(this._createRow(id, null, true));
            }
        } finally {
            this._rebuilding = false;
        }
    }

    _addRow(row) {
        this._rows.push(row);
        this._group.add(row);
    }

    _createRow(id, name, hidden) {
        const row = new Adw.SwitchRow({
            title: name || id,
            subtitle: name ? id : _('Not running right now'),
            active: hidden,
        });

        row.connect('notify::active', widget => {
            if (this._rebuilding)
                return;

            this._setHidden(id, widget.get_active());
        });

        return row;
    }

    _setHidden(id, hidden) {
        const hiddenIcons = new Set(
            this._settings.get_strv(this._settingsKey.HIDDEN_ICONS));

        if (hidden)
            hiddenIcons.add(id);
        else
            hiddenIcons.delete(id);

        this._settings.set_strv(this._settingsKey.HIDDEN_ICONS, [...hiddenIcons]);
    }
});
