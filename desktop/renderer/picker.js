/* Shared composer pickers keep native selects as the sole state/change contract. */
(function () {
  'use strict';
  let active, sequence = 0;
  const instances = new WeakMap();
  // Registered before composer Escape handling: dismissing a picker must not stop a task.
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active?.isOpen()) {
      event.preventDefault(); event.stopImmediatePropagation(); active.close(true);
    }
  }, true);
  window.enhancePicker = function (select, { kind = 'model', label = '选择模型', searchable = false, descriptions = {} } = {}) {
    if (instances.has(select)) return instances.get(select);
    function element(tag, className, text) {
      const node = document.createElement(tag); node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function icon(className, path) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', className); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7');
      const line = document.createElementNS(svg.namespaceURI, 'path'); line.setAttribute('d', path); svg.append(line); return svg;
    }
    const button = element('button', 'agent-picker'), caption = element('span', 'picker-label');
    button.type = 'button'; button.dataset.kind = kind; button.id = (select.id || 'picker-' + ++sequence) + '-trigger';
    button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
    button.append(icon('picker-icon', kind === 'permission' ? 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6L12 3Z M8 12l3 3 5-6' : 'M12 3 4 7v10l8 4 8-4V7l-8-4Z M4 7l8 5 8-5 M12 12v9'), caption,
      icon('picker-chevron', 'm7 10 5 5 5-5'));
    const popover = element('div', 'picker-popover'); popover.dataset.kind = kind; popover.popover = 'auto';
    popover.id = button.id + '-popover'; button.setAttribute('aria-controls', popover.id);
    const header = element('div', 'picker-header'), title = element('span', 'picker-title', label), count = element('span', 'picker-count');
    header.append(title, count); popover.append(header);
    const list = element('div', 'picker-options'); list.id = button.id + '-options'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', label);
    const search = searchable ? element('input', 'picker-search') : null;
    if (search) {
      search.type = 'search'; search.placeholder = '搜索模型或服务商'; search.setAttribute('aria-label', '搜索模型或服务商');
      search.setAttribute('aria-controls', list.id); popover.append(search);
    }
    popover.append(list); document.body.append(popover); select.after(button);
    select.hidden = true; select.style.display = 'none'; select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    let rows = [];
    const isOpen = () => popover.matches(':popover-open');
    function close(restoreFocus) {
      if (!isOpen()) return;
      popover.hidePopover(); button.setAttribute('aria-expanded', 'false');
      if (active?.button === button) active = null;
      if (restoreFocus && !button.disabled) button.focus({ preventScroll: true });
    }
    function focusRow(index) {
      if (!rows.length) return;
      const row = rows[(index + rows.length) % rows.length];
      rows.forEach(n => { n.tabIndex = n === row ? 0 : -1; }); row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' });
    }
    function render() {
      const focusValue = list.contains(document.activeElement) ? document.activeElement.dataset.value : null;
      const query = (search?.value || '').trim().toLocaleLowerCase(); rows = []; list.replaceChildren();
      const options = Array.from(select.options).filter(option => !option.hidden);
      for (const option of options) {
        const name = option.dataset.label || option.textContent, detail = option.dataset.detail || descriptions[option.value] || '';
        if (query && !(name + ' ' + detail).toLocaleLowerCase().includes(query)) continue;
        const row = element('button', 'picker-option'); row.type = 'button'; row.dataset.value = option.value;
        row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(option.selected)); row.disabled = option.disabled;
        row.tabIndex = -1;
        const text = element('span', 'picker-option-text'); text.append(element('span', 'picker-option-main', name));
        if (detail) text.append(element('span', 'picker-option-detail', detail));
        row.append(text, icon('picker-check', 'm5 12 4 4L19 6'));
        row.addEventListener('click', () => {
          if (select.disabled || row.disabled) return;
          const changed = select.value !== option.value;
          select.value = option.value;
          // Focus before dispatch: an async host confirmation owns focus after change.
          close(true); sync();
          if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
          sync();
        });
        list.append(row); if (!row.disabled) rows.push(row);
      }
      count.textContent = `${list.children.length} / ${options.length}`;
      if (!list.children.length) list.append(element('div', 'picker-empty', '没有匹配的选项'));
      const selected = rows.find(row => row.dataset.value === select.value) || rows[0];
      if (selected) selected.tabIndex = 0;
      if (focusValue !== null) focusRow(Math.max(0, rows.findIndex(row => row.dataset.value === focusValue)));
    }
    function position() {
      if (!isOpen()) return;
      const rect = button.getBoundingClientRect(), margin = 8, gap = 6;
      const width = Math.max(0, Math.min(kind === 'permission' ? 320 : 360, innerWidth - 24));
      const above = Math.max(0, rect.top - margin - gap), below = Math.max(0, innerHeight - rect.bottom - margin - gap);
      const up = below < 320 && above > below;
      popover.style.position = 'fixed'; popover.style.margin = '0'; popover.style.inset = 'auto';
      popover.style.width = width + 'px'; popover.style.maxHeight = Math.min(440, up ? above : below) + 'px';
      popover.style.left = Math.max(margin, Math.min(rect.right - width, innerWidth - width - margin)) + 'px';
      const height = popover.getBoundingClientRect().height;
      popover.style.top = Math.max(margin, up ? rect.top - gap - height : rect.bottom + gap) + 'px';
    }
    function open(direction) {
      if (select.disabled) return;
      if (active?.button !== button) active?.close(false);
      if (search) search.value = '';
      render(); popover.showPopover(); active = { button, close, isOpen }; button.setAttribute('aria-expanded', 'true'); position();
      if (search && !direction) search.focus({ preventScroll: true });
      else focusRow(direction === 'last' ? rows.length - 1 : Math.max(0, rows.findIndex(row => row.dataset.value === select.value)));
    }
    function sync() {
      const option = select.selectedOptions[0];
      caption.textContent = option?.dataset.label || option?.textContent || label;
      button.title = [caption.textContent, option?.dataset.detail, select.title].filter(Boolean).join(' · ');
      button.setAttribute('aria-label', label + '：' + caption.textContent);
      button.disabled = select.disabled;
      if (button.disabled) close(false);
      else if (isOpen()) { render(); position(); }
    }
    button.addEventListener('click', () => isOpen() ? close(true) : open());
    button.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault(); open(event.key === 'ArrowUp' ? 'last' : event.key === 'ArrowDown' ? 'first' : undefined);
    });
    popover.addEventListener('keydown', event => {
      if (event.key === 'Tab') { close(false); button.focus({ preventScroll: true }); return; }
      if (event.target === search) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focusRow(event.key === 'ArrowUp' ? rows.length - 1 : 0); }
        return;
      }
      const current = rows.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); focusRow(event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : current + (event.key === 'ArrowUp' ? -1 : 1));
      } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); rows[current]?.click(); }
    });
    search?.addEventListener('input', () => { render(); position(); });
    popover.addEventListener('toggle', () => {
      button.setAttribute('aria-expanded', String(isOpen()));
      if (!isOpen() && active?.button === button) active = null;
    });
    window.addEventListener('resize', position);
    window.addEventListener('scroll', event => { if (isOpen() && !popover.contains(event.target)) close(false); }, true);
    select.addEventListener('change', sync);
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['disabled', 'selected', 'label', 'title', 'data-label', 'data-detail', 'hidden'] });
    const result = { sync }; instances.set(select, result); sync(); return result;
  };
})();
