// The forms as shown, assembled in the browser (src/shared/client-views.ts): their fixed part (static `forms.specs`) with
// what is available now and the data `prepare` sent (`forms.patches`), worded by the parts at "forms.prepare".
import type { FormPatches } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { resolveForms } from '../../../src/shared/forms';

export const views = [
	defineClientView({
		id: 'ui.forms',
		needs: ['forms.patches'],
		// The parts that word forms may read the big object (their `needs`): fetched with it, and followed at once.
		points: ['forms.prepare'],
		compute: (get) => resolveForms(get, get.data<FormPatches>('forms.patches')),
	}),
];
