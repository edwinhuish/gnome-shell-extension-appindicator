/* exported  GeneralPage*/

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';


/**
 * The spacing is a single value, the mode only names it: either the space one
 * of the presets asks for, or "custom" once the user picked a value of his own.
 */
const SPACING_MODE = {
    NORMAL: 'normal',
    COMPACT: 'compact',
    CUSTOM: 'custom',
};

/**
 * Preset spacings, in pixel per side of an icon: what the shell theme gives the
 * panel icons by default, and what the old compact mode used to ask for.
 */
const SPACING_PRESETS = {
    [SPACING_MODE.NORMAL]: 22,
    [SPACING_MODE.COMPACT]: 10,
};

const SPACING_MAX = 32;


export var GeneralPage = GObject.registerClass(
class AppIndicatorGeneralPage extends Adw.PreferencesPage {
    _init(settings, settingsKey) {
        super._init({
            title: _('General'),
            icon_name: 'general-preferences-symbolic',
            name: 'General Page',
        });

        this._settings = settings;
        this._settingsKey = settingsKey;

        this.group = new Adw.PreferencesGroup();  // no title since only single group

        const legacyTraySwitch = new Adw.SwitchRow({
            title: _('Enable Legacy Tray Icons support'),
            subtitle: _('Add X11 legacy tray icons to the panel area'),
            active: this._settings.get_boolean(this._settingsKey.LEGACY_TRAY_ENABLED),
        });

        legacyTraySwitch.connect('notify::active', widget =>
            this._settings.set_boolean(
                this._settingsKey.LEGACY_TRAY_ENABLED,
                widget.get_active()
            )
        );

        this.group.add(legacyTraySwitch);

        this._createSpacingRow();

        const languageAreaSwitch = new Adw.SwitchRow({
            title: _('Show Language Area'),
            subtitle: _('Keeps the language (input source) area at the left of the tray icons'),
            active: this._settings.get_boolean(this._settingsKey.LANGUAGE_AREA_ENABLED),
        });

        languageAreaSwitch.connect('notify::active', widget =>
            this._settings.set_boolean(
                this._settingsKey.LANGUAGE_AREA_ENABLED,
                widget.get_active()
            )
        );

        this.group.add(languageAreaSwitch);

        this._createSpinRow({
            title: _('Opacity'),
            settingsKey: this._settingsKey.ICON_OPACITY,
            from: 0,
            to: 255,
            step: 1,
            round: true,
        });

        this._createSpinRow({
            title: _('Desaturation'),
            settingsKey: this._settingsKey.ICON_SATURATION,
            from: 0.0,
            to: 1.0,
            step: 0.1,
        });

        this._createSpinRow({
            title: _('Brightness'),
            settingsKey: this._settingsKey.ICON_BRIGHTNESS,
            from: -1.0,
            to: 1.0,
            step: 0.1,
        });

        this._createSpinRow({
            title: _('Contrast'),
            settingsKey: this._settingsKey.ICON_CONTRAST,
            from: -1.0,
            to: 1.0,
            step: 0.1,
        });

        this._createSpinRow({
            title: _('Icon Size'),
            settingsKey: this._settingsKey.ICON_SIZE,
            from: 0,
            to: 96,
            step: 2,
            round: true,
        });

        const alignmentList = new Gtk.StringList();
        const comboItems = [
            {pos: 'center', label: _('Center')},
            {pos: 'left', label: _('Left')},
            {pos: 'right', label: _('Right')},
        ];

        comboItems.forEach(item => alignmentList.append(item.label));

        const combo = new Adw.ComboRow({
            title: _('Tray Horizontal Alignment'),
            model: alignmentList,
        });
        const trayPos = this._settings.get_string(this._settingsKey.TRAY_POS);
        combo.set_selected(comboItems.findIndex(item => trayPos === item.pos));

        combo.connect('notify::selected', widget => this._settings.set_string(
            this._settingsKey.TRAY_POS, comboItems[widget.get_selected()].pos));

        this.group.add(combo);
        this.add(this.group);
    }

    /**
     * Builds the single "Icon Spacing" setting: a mode selector naming the
     * spacing and the slider holding it. Choosing the normal or the compact
     * mode moves the slider onto the preset it stands for, choosing the custom
     * mode (or moving the slider) keeps whatever spacing is set.
     */
    _createSpacingRow() {
        const spacingKey = this._settingsKey.TRAY_ICON_SPACING;
        const spacing = this._settings.get_int(spacingKey);

        this._spacingModes = [
            {mode: SPACING_MODE.NORMAL, label: _('Normal')},
            {mode: SPACING_MODE.COMPACT, label: _('Compact')},
            {mode: SPACING_MODE.CUSTOM, label: _('Custom')},
        ];

        const modeList = new Gtk.StringList();
        for (const {label} of this._spacingModes)
            modeList.append(label);

        this._spacingModeDropdown = new Gtk.DropDown({
            model: modeList,
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Preset the icon spacing comes from'),
        });

        this._spacingScale = this._createScale({
            from: 0,
            to: SPACING_MAX,
            step: 1,
            value: spacing,
        });

        // Neither widget may take the update done for the other one as a user
        // edit, otherwise setting a preset would immediately turn it custom.
        this._spacingUpdating = false;
        this._syncSpacingWidgets(spacing, this._spacingModeForValue(spacing));

        this._spacingScale.connect('value-changed', () => {
            if (this._spacingUpdating)
                return;

            this._settings.set_int(spacingKey,
                Math.round(this._spacingScale.get_value()));

            // Dragging the slider means the user is done with the presets.
            this._selectSpacingMode(SPACING_MODE.CUSTOM);
        });

        this._spacingModeDropdown.connect('notify::selected', () => {
            if (this._spacingUpdating)
                return;

            const {mode} = this._spacingModes[this._spacingModeDropdown.get_selected()];

            // The custom mode only drops the preset: the spacing stays where it
            // is and is adjusted with the slider from there.
            if (mode === SPACING_MODE.CUSTOM)
                return;

            this._applySpacingPreset(mode);
        });

        const suffix = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            valign: Gtk.Align.CENTER,
        });
        suffix.append(this._spacingModeDropdown);
        suffix.append(this._spacingScale);

        const row = new Adw.ActionRow({
            title: _('Icon Spacing'),
            subtitle: _('Space the tray icons, the language area and the fold button keep on both of their sides'),
        });
        row.add_suffix(suffix);

        this.group.add(row);
    }

    _createScale(args) {
        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: args.from,
                upper: args.to,
                step_increment: args.step,
                page_increment: args.step * 5,
            }),
            draw_value: true,
            digits: 0,
            hexpand: true,
            width_request: 180,
            valign: Gtk.Align.CENTER,
        });

        scale.set_value(args.value);

        return scale;
    }

    _applySpacingPreset(mode) {
        const spacing = SPACING_PRESETS[mode];

        this._settings.set_int(this._settingsKey.TRAY_ICON_SPACING, spacing);
        this._syncSpacingWidgets(spacing, mode);
    }

    /**
     * Brings the slider and the mode selector in line with each other.
     */
    _syncSpacingWidgets(spacing, mode) {
        this._spacingUpdating = true;
        this._spacingScale.set_value(spacing);
        this._selectSpacingMode(mode);
        this._spacingUpdating = false;
    }

    _selectSpacingMode(mode) {
        const index = this._spacingModes
            .findIndex(entry => entry.mode === mode);

        this._spacingUpdating = true;
        this._spacingModeDropdown.set_selected(index);
        this._spacingUpdating = false;
    }

    /**
     * @param {number} spacing the spacing currently set.
     * @returns {string} the mode that spacing is the preset of, if any.
     */
    _spacingModeForValue(spacing) {
        const preset = Object.entries(SPACING_PRESETS)
            .find(([, value]) => value === spacing);

        return preset ? preset[0] : SPACING_MODE.CUSTOM;
    }

    _createSpinRow(args) {
        let title =  args.title || 'Default Title';
        let subtitle = args.subtitle || null;
        let settingsKey = args.settingsKey || '';
        let from = args.from || 0;
        let to = args.to || 100;
        let step = args.step || 1;
        let round = args.round || false;

        let spin = Adw.SpinRow.new_with_range(from, to, step);
        spin.title = title;
        if (subtitle !== null)
            spin.subtitle = subtitle;

        if (round)
            spin.set_value(this._settings.get_int(settingsKey));
        else
            spin.set_value(this._settings.get_double(settingsKey));


        spin.connect('input', widget => {
            if (round)
                this._settings.set_int(settingsKey, parseInt(widget.get_value(), 10));
            else
                this._settings.set_double(settingsKey, widget.get_value());

            return false;
        });
        spin.connect('output', widget => {
            if (round)
                this._settings.set_int(settingsKey, parseInt(widget.get_value(), 10));
            else
                this._settings.set_double(settingsKey, widget.get_value());

            return false;
        });

        this.group.add(spin);
    }
});


