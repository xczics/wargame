// The forms as shown, assembled in the browser (src/shared/client-views.ts): their fixed part (static `forms.specs`) with
// what is available now and `prepare` added (`forms.patches`).
import type { FormPatches, FormSpecs } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { resolveForms } from '../../../src/shared/forms';

export const views = [
	defineClientView({
		id: 'ui.forms',
		needs: ['forms.patches'],
		compute: (get) => resolveForms(get.static<FormSpecs>('forms.specs'), get.data<FormPatches>('forms.patches')),
	}),
];
