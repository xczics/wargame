/** View `clock.settings`: what both halves of the clock example share. */
export interface ClockSettings {
	/** Hours added to UTC for the shown time (GM rule `clock.utcOffset`). */
	utcOffset: number;
}
