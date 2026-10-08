// Runs before paint to avoid a flash of the wrong theme. Dark is the default;
// only an explicit 'light' choice in localStorage opts back out.
export const themeInitScript =
  "(function(){try{if(localStorage.getItem('theme')!=='light')document.documentElement.classList.add('dark')}catch(e){}})()";
