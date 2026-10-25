// The browser tab's title: the site's name (index.html, or the GM's personalization) with marks other plugins put in
// front (e.g. the assistant's ⚠️). Each sets only its own part, so neither writes the other's back.
const builtIn = document.title;
let base = builtIn;
const marks = new Map<string, string>();
const apply = () => (document.title = [...marks.values(), base].join(' '));

export const tabTitle = {
	/** What the page came with, for when the GM clears the name. */
	builtIn,
	set(title: string) {
		base = title;
		apply();
	},
	/** A mark of `owner`'s in front of the title, or none. */
	mark(owner: string, mark: string | null) {
		if (mark) marks.set(owner, mark);
		else marks.delete(owner);
		apply();
	},
};
