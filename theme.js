// loaded in <head>: applies the saved or system theme before the page is painted, then wires up the toggle
;(() => {
	"use strict"

	const STORAGE_KEY = "vkrc:theme"
	const root = document.documentElement
	const media = window.matchMedia("(prefers-color-scheme: dark)")

	const loadChoice = () => {
		try {
			return localStorage.getItem(STORAGE_KEY)
		} catch (e) {
			return null
		}
	}

	const saveChoice = theme => {
		try {
			localStorage.setItem(STORAGE_KEY, theme)
		} catch (e) {
			//the choice just won't survive a reload
		}
	}

	const apply = theme => {
		root.dataset.theme = theme
		const button = document.getElementById("theme-toggle")
		if (!button) return
		const label = theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"
		button.setAttribute("aria-label", label)
		button.title = label
	}

	apply(loadChoice() || (media.matches ? "dark" : "light"))

	// follow the system until the user picks a theme by hand
	media.addEventListener("change", event => {
		if (!loadChoice()) apply(event.matches ? "dark" : "light")
	})

	document.addEventListener("DOMContentLoaded", () => {
		apply(root.dataset.theme)
		document.getElementById("theme-toggle").addEventListener("click", () => {
			const theme = root.dataset.theme === "dark" ? "light" : "dark"
			saveChoice(theme)
			apply(theme)
		})
	})
})()
