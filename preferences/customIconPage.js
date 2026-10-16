/* exported  CustomIconPage*/

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const IconData = GObject.registerClass({
    GTypeName: 'IconData',
    Properties: {
        'id': GObject.ParamSpec.string(
            'id',
            'Id',
            'A read and write string property',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'name': GObject.ParamSpec.string(
            'name',
            'Name',
            'A read and write string property',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'at-name': GObject.ParamSpec.string(
            'at-name',
            'At Name',
            'A read and write string property',
            GObject.ParamFlags.READWRITE,
            ''
        ),

    },
}, class IconData extends GObject.Object {
    constructor(props = {}) {
        super(props);
    }

    get id() {
        if (this._id === 'undefined')
            this._id = null;
        return this._id;
    }

    set id(value) {
        if (this.id === value)
            return;

        this._id = value;
        this.notify('id');
    }

    get name() {
        if (this._name === 'undefined')
            this._name = null;
        return this._name;
    }

    set name(value) {
        if (this.name === value)
            return;

        this._name = value;
        this.notify('name');
    }

    get atName() {
        if (this._atName === 'undefined')
            this._atName = null;
        return this._atName;
    }

    set atName(value) {
        if (this.atName === value)
            return;

        this._atName = value;
        this.notify('at-name');
    }
});

export var CustomIconPage = GObject.registerClass(
class AppIndicatorCustomIconPage extends Adw.PreferencesPage {
    _init(settings, settingsKey) {
        super._init({
            title: _('Custom Icons'),
            icon_name: 'custom-icons-symbolic',
            name: 'Custom Icons Page',
        });
        this._settings = settings;
        this._settingsKey = settingsKey;

        this.group = new Adw.PreferencesGroup();

        this.container = new Gtk.Box({
            halign: Gtk.Align.FILL,
            hexpand: true,
            orientation: Gtk.Orientation.VERTICAL,
        });

        this.listStore = new Gio.ListStore({
            item_type: IconData,
        });

        // An indicator can only be customized once, so entries stored more than
        // once (by an older version of this page) are collapsed here.
        for (const data of this._initialIcons())
            this.listStore.append(data);

        this.listStore.append(new IconData({id: '', name: '', atName: ''}));

        this.selectionModel = new Gtk.SingleSelection({
            model: this.listStore,
        });

        this.columnView = new Gtk.ColumnView({
            hexpand: true,
            model: this.selectionModel,
            reorderable: false,
        });

        // The three columns of the list: the title shown to the user, the name
        // the icon data is reached with in JavaScript and the name of the
        // GObject property holding it. The titles are translated here and not
        // while the module is loaded, gettext resolves the extension from the
        // call stack and refuses to run for a module being imported.
        const columns = [
            {title: _('Indicator ID'), accessor: 'id', property: 'id'},
            {title: _('Icon Name'), accessor: 'name', property: 'name'},
            {title: _('Attention Icon Name'), accessor: 'atName', property: 'at-name'},
        ];

        for (const column of columns) {
            const viewColumn = new Gtk.ColumnViewColumn({
                title: column.title,
                expand: true,
            });
            viewColumn.set_factory(this._createEntryFactory(column));

            this.columnView.append_column(viewColumn);
        }

        this.container.append(this.columnView);

        this.group.add(this.container);
        this.add(this.group);
    }

    /**
     * @returns {IconData[]} the custom icons that are stored, one per indicator.
     */
    _initialIcons() {
        const customIcons = new Map();

        for (const [id, name, atName] of this._settings
            .get_value(this._settingsKey.CUSTOM_ICONS).deep_unpack()) {
            if (id && name)
                customIcons.set(id, new IconData({id, name, atName}));
        }

        return [...customIcons.values()];
    }

    /**
     * Builds the factory editing one property of the custom icons.
     *
     * The view recycles its widgets, so the entry is wired up once and then
     * bound to the row it currently shows. Connecting the handler again on
     * every bind would run the same edit several times and the list would end
     * up holding the same custom icon more than once.
     *
     * @param {object} column the column to build the factory for.
     * @returns {Gtk.SignalListItemFactory} the factory.
     */
    _createEntryFactory(column) {
        const factory = new Gtk.SignalListItemFactory();

        factory.connect('setup', (_factory, item) => {
            const entry = new Gtk.Entry({hexpand: true, max_width_chars: 20});

            entry.connect('changed', () => {
                if (entry._updating)
                    return;

                this._autoSave(entry);
            });

            item.set_child(entry);
        });

        factory.connect('bind', (_factory, item) => {
            const entry = item.get_child();
            const data = item.get_item();

            entry._data = data;
            entry._updating = true;

            // The entry is recycled, so it is filled with the row it shows now
            // before the binding may write its old text back into the data.
            entry.set_text(data[column.accessor] ?? '');
            entry._binding = entry.bind_property('text', data, column.property,
                GObject.BindingFlags.SYNC_CREATE);

            entry._updating = false;
        });

        factory.connect('unbind', (_factory, item) => {
            const entry = item.get_child();

            entry._binding?.unbind();
            delete entry._binding;
            delete entry._data;
        });

        return factory;
    }

    /**
     * Stores what the user typed, and adds an empty row behind the last one so
     * that another icon can be added.
     *
     * @param {Gtk.Entry} entry the entry the user typed into.
     */
    _autoSave(entry) {
        const data = entry._data;

        if (!data)
            return;

        this._storeCustomIcons();

        if (!data.id && !data.name)
            return;

        let position = -1;
        for (let i = 0; i < this.listStore.get_n_items(); i++) {
            if (this.listStore.get_item(i) === data) {
                position = i;
                break;
            }
        }

        // Filling in the row at the end of the list adds a new empty one.
        if (position === this.listStore.get_n_items() - 1) {
            this.listStore.append(new IconData({id: '', name: '', atName: ''}));
            return;
        }

        // The row may now hold an indicator that is customized further up in
        // the list already, in which case the older entry goes away.
        this._queueDuplicateCleanup();
    }

    /**
     * Writes the list of custom icons, dropping the rows that are not filled in
     * and keeping only one entry per indicator.
     */
    _storeCustomIcons() {
        const customIcons = new Map();

        for (let i = 0; i < this.listStore.get_n_items(); i++) {
            const {id, name, atName} = this.listStore.get_item(i);

            if (id && name)
                customIcons.set(id, [id, name, atName || '']);
        }

        this._settings.set_value(this._settingsKey.CUSTOM_ICONS,
            new GLib.Variant('a(sss)', [...customIcons.values()]));
    }

    /**
     * Removes the rows that customize an indicator an other row already
     * customizes, so that the same custom icon is only ever listed once.
     *
     * The rows are never touched while one of their widgets emits a signal,
     * that would tear down the widget we are called from.
     */
    _queueDuplicateCleanup() {
        if (this._cleanupId)
            return;

        this._cleanupId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            delete this._cleanupId;
            this._removeDuplicateRows();
            return GLib.SOURCE_REMOVE;
        });
    }

    _removeDuplicateRows() {
        const seen = new Set();

        // Back to front, so that the row the user just edited is the one kept.
        for (let i = this.listStore.get_n_items() - 1; i >= 0; i--) {
            const {id, name} = this.listStore.get_item(i);

            if (!id || !name)
                continue;

            if (seen.has(id))
                this.listStore.remove(i);
            else
                seen.add(id);
        }
    }
});
