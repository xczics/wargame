// Custom editors for form fields of type 'widget', registered by other client plugins.
import type { Component } from 'vue';
import type { FormField } from '../../../src/shared/api';

export interface FormWidget {
	/**
	 * Receives props `field` (with the server's `data`), `values` (the other fields, reactive)
	 * and `modelValue`; emits `update:modelValue`.
	 */
	component: Component;
	/** What the value adds to the payload; default `{ [field.name]: value }`. */
	payload?(value: unknown, field: FormField): Record<string, unknown>;
}

export const widgets = new Map<string, FormWidget>();
