'use strict';

// Rearrange existing admin controls without replacing their elements or listeners.
const adminPanel = document.getElementById('demoAdmin');
if (adminPanel) {
  let group;
  for (const node of Array.from(adminPanel.children)) {
    if (node.tagName === 'H2') {
      group = document.createElement('details');
      group.className = 'demo-admin-group';
      const summary = document.createElement('summary');
      summary.textContent = node.textContent;
      group.appendChild(summary);
      node.before(group);
    }
    if (group) group.appendChild(node);
  }
  const overview = document.getElementById('demoOverview');
  const sources = [
    ['demoTotals', 'demoOverviewTotals'],
    ['demoReportTotals', 'demoOverviewPeriod'],
    ['demoReportMachines', 'demoOverviewMachines']
  ];
  const update = () => {
    overview.hidden = adminPanel.hidden;
    for (const [source, target] of sources) {
      document.getElementById(target).textContent = document.getElementById(source).textContent.trim() || 'Henüz veri yok.';
    }
  };
  const observer = new MutationObserver(update);
  observer.observe(adminPanel, { attributes: true, attributeFilter: ['hidden'] });
  for (const [source] of sources) observer.observe(document.getElementById(source), { childList: true, subtree: true, characterData: true });
  update();
}
