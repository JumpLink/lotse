#!/usr/bin/env -S gjs -m
/**
 * Can a `Gtk.DropDown` hold "nothing is selected", and does picking the first row then still emit?
 *
 * The question is not academic. A host `modelPolicy` that denies the model in use leaves the row's
 * `selected` at `-1` (`core/config-row.ts`), and the widget writes that as
 * `Gtk.INVALID_LIST_POSITION`. If GTK quietly turns that into row 0, the dropdown *shows* a value
 * nobody chose and — worse — picking that same value emits no `notify::selected`, so the one action
 * the blocked composer asks for would do nothing and the person would be stuck with no way out.
 *
 * Run: gjs -m scripts/probes/dropdown-no-selection.mjs
 */

import Gtk from 'gi://Gtk?version=4.0';

Gtk.init();

const INVALID = Gtk.INVALID_LIST_POSITION;
const names = ['model-001', 'model-002'];

function list() {
  const model = new Gtk.StringList();
  for (const name of names) model.append(name);
  return model;
}

function report(label, value) {
  console.log(`${label}: ${value === INVALID ? 'INVALID_LIST_POSITION' : value}`);
}

// 1. The construction the widget actually does: `model` and `selected` in one property dict.
const constructed = new Gtk.DropDown({ model: list(), selected: INVALID });
report('1. constructed with { model, selected: INVALID }', constructed.selected);

// 2. The same thing in two steps, which is what the property dict may or may not be doing.
const stepwise = new Gtk.DropDown({ model: list() });
report('2a. after setting the model alone', stepwise.selected);
stepwise.selected = INVALID;
report('2b. after assigning INVALID afterwards', stepwise.selected);

// 3. What the selection model underneath says about itself — `autoselect` is the property that
//    decides whether "nothing" is a state this widget may be in at all.
const selection = stepwise.model;
console.log(`3. the drop-down's model is a ${selection?.constructor?.name ?? 'null'}`);
if (selection instanceof Gtk.SingleSelection) {
  console.log(`   autoselect=${selection.autoselect} can_unselect=${selection.canUnselect}`);
}

// 4. The part that decides whether the person is stuck: with nothing selected, does choosing the
//    first row emit `notify::selected`?
const emitting = new Gtk.DropDown({ model: list(), selected: INVALID });
let emitted = 0;
let sawValue = null;
emitting.connect('notify::selected', () => {
  emitted += 1;
  sawValue = emitting.selected;
});
emitting.selected = 0;
console.log(`4. picking row 0 from "nothing": ${emitted} notify, selected=${sawValue}`);

// 5. And the control case: from row 0, picking row 0 again emits nothing. This is the behaviour that
//    would strand a person if case 1 answered 0.
const same = new Gtk.DropDown({ model: list(), selected: 0 });
let again = 0;
same.connect('notify::selected', () => {
  again += 1;
});
same.selected = 0;
console.log(`5. picking row 0 from row 0: ${again} notify`);
