module.exports = {
  docs: [
    'getting-started',
    'how-it-works',
    {
      Reference: [
        {
          'JavaScript Reference': [
            {
              type: 'autogenerated',
              dirName: 'api', // 'api' is the 'out' directory
            },
          ],
        },
        'server-push',
        'server-pull',
      ],
    },
    {
      'Integration Guide': [
        'guide-intro',
        'guide-design-client-view',
        'guide-install-replicache',
        'guide-render-ui',
        'guide-local-mutations',
        'guide-database-setup',
        'guide-remote-mutations',
        'guide-dynamic-pull',
        'guide-poke',
        'guide-conclusion',
      ],
    },
    {
      Recipes: ['recipe-blobs'],
    },
    {
      Samples: ['sample-todo', 'sample-replidraw'],
    },
    'licensing',
    'launch-checklist',
    'design',
    'faq',
  ],
};
