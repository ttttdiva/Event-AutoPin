/** 単一選択の小さな select は、開いている間だけ数字で選べる一覧を使う。 */
export function installNumericSelects(): void {
  let closeCurrent: (() => void) | undefined;
  const visibleOptions = (select: HTMLSelectElement) => Array.from(select.options).filter((option) =>
    !option.hidden && !option.closest('optgroup[hidden]') && getComputedStyle(option).display !== 'none' && getComputedStyle(option).visibility !== 'hidden' &&
    (!(option.parentElement instanceof HTMLOptGroupElement) || (getComputedStyle(option.parentElement).display !== 'none' && getComputedStyle(option.parentElement).visibility !== 'hidden')));
  const eligible = (select: HTMLSelectElement) => {
    const options = visibleOptions(select);
    return !select.matches(':disabled, [readonly], [aria-readonly="true"]') && select.getClientRects().length > 0 && getComputedStyle(select).visibility !== 'hidden' && !select.multiple && select.size <= 1 && options.length > 0 && options.length <= 10;
  };
  const open = (select: HTMLSelectElement) => {
    closeCurrent?.();
    const options = visibleOptions(select);
    const popup = document.createElement('div');
    popup.className = 'numeric-select-popup';
    popup.id = 'numeric-select-popup';
    const previousExpanded = select.getAttribute('aria-expanded');
    const previousControls = select.getAttribute('aria-controls');
    select.setAttribute('aria-expanded', 'true');
    select.setAttribute('aria-controls', popup.id);
    let search = '';
    let searchTime = 0;
    popup.tabIndex = -1;
    popup.setAttribute('role', 'listbox');
    popup.setAttribute('aria-label', select.getAttribute('aria-label') || select.labels?.[0]?.textContent?.trim() || select.title || '選択');
    let index = Math.max(0, options.indexOf(select.selectedOptions[0]));
    const disabled = (option: HTMLOptionElement) => option.disabled || !!option.closest('optgroup:disabled');
    const paint = () => {
      popup.setAttribute('aria-activedescendant', `numeric-select-option-${index}`);
      Array.from(popup.children).forEach((node, i) => {
        node.classList.toggle('active', i === index);
        node.setAttribute('aria-selected', String(options[i].selected));
      });
    };
    const close = (focus: boolean) => {
      document.removeEventListener('pointerdown', outside, true);
      popup.remove();
      for (const [name, value] of [['aria-expanded', previousExpanded], ['aria-controls', previousControls]] as const) {
        if (value === null) select.removeAttribute(name);
        else select.setAttribute(name, value);
      }
      if (closeCurrent === closeWithoutFocus) closeCurrent = undefined;
      if (focus && select.isConnected) select.focus();
    };
    const closeWithoutFocus = () => close(false);
    const outside = (event: PointerEvent) => {
      if (!popup.contains(event.target as Node)) close(false);
    };
    const choose = (i: number) => {
      const option = options[i];
      if (!option || disabled(option) || !eligible(select) || !option.isConnected || !visibleOptions(select).includes(option)) return;
      const oldValue = select.value;
      select.selectedIndex = Array.from(select.options).indexOf(option);
      const changed = select.value !== oldValue;
      close(true);
      if (changed) {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
    options.forEach((option, i) => {
      const item = document.createElement('div');
      item.id = `numeric-select-option-${i}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-disabled', String(disabled(option)));
      item.textContent = option.textContent;
      item.addEventListener('click', () => choose(i));
      popup.appendChild(item);
    });
    paint();
    document.body.appendChild(popup);
    const rect = select.getBoundingClientRect();
    popup.style.minWidth = `${rect.width}px`;
    popup.style.left = `${Math.max(0, Math.min(rect.left, innerWidth - popup.offsetWidth))}px`;
    popup.style.top = `${rect.bottom + popup.offsetHeight <= innerHeight ? rect.bottom : Math.max(0, rect.top - popup.offsetHeight)}px`;
    popup.addEventListener('keydown', (event) => {
      if (event.isComposing || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
      // 数字は label の typeahead よりも即決定を優先する。
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault(); event.stopPropagation();
        choose(event.key === '0' ? 9 : Number(event.key) - 1);
      } else if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close(true);
      } else if (event.key === 'Tab') {
        close(true);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation(); choose(index);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); event.stopPropagation();
        const indices = options.map((_, i) => i);
        if (event.key === 'End') indices.reverse();
        const found = indices.find((i) => !disabled(options[i]));
        if (found !== undefined) { index = found; paint(); }
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        for (let i = index + step; i >= 0 && i < options.length; i += step) {
          if (!disabled(options[i])) { index = i; paint(); break; }
        }
      } else if (event.key.length === 1) {
        event.preventDefault(); event.stopPropagation();
        const now = Date.now();
        search = (now - searchTime < 1000 ? search : '') + event.key.toLocaleLowerCase();
        searchTime = now;
        const found = options.findIndex((option) => !disabled(option) && option.label.trim().toLocaleLowerCase().startsWith(search));
        if (found >= 0) { index = found; paint(); }
      }
    });
    closeCurrent = closeWithoutFocus;
    document.addEventListener('pointerdown', outside, true);
    popup.focus();
  };
  document.addEventListener('pointerdown', (event) => {
    const select = event.target;
    if (event.button !== 0 || !(select instanceof HTMLSelectElement) || !eligible(select)) return;
    event.preventDefault();
    open(select);
  }, true);
  document.addEventListener('keydown', (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !eligible(select) || event.isComposing || event.repeat || event.ctrlKey || event.metaKey) return;
    if ((event.key === ' ' || event.key === 'Enter') && !event.altKey || event.key === 'ArrowDown' && event.altKey) {
      event.preventDefault();
      open(select);
    }
  }, true);
}
