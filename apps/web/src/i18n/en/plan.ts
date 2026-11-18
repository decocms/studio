export const plan = {
  "plan.objective.eyebrow": "Your store goal",
  "plan.objective.empty":
    "Write in one sentence what the store needs now. Every plan starts from it.",
  "plan.objective.write": "Write the goal",
  "plan.objective.suggest": "Suggest a goal",
  "plan.objective.edit": "Edit",
  "plan.objective.label": "Store goal",
  "plan.objective.placeholder":
    "E.g. Sell as well on mobile as on desktop, without spending more on media.",
  "plan.objective.hint":
    "One sentence, the way you would say it to your team. The agents take it into every plan.",
  "plan.objective.save": "Save",
  "plan.objective.cancel": "Cancel",
  "plan.objective.clear": "Clear goal",
  "plan.objective.saveError": "Could not save the goal. Try again.",
  "plan.idea.heading": "What do you want to improve in the store?",
  "plan.idea.description":
    "Describe the idea. The agent turns it into a business case: the problem in numbers, who already does it, the money at stake, effort and the A/B test.",
  "plan.idea.label": "Your idea",
  "plan.idea.placeholder":
    "E.g. Show the delivery date on the product page before adding to cart.",
  "plan.idea.submit": "Create the plan",
  "plan.idea.startWith": "Start with",
  "plan.idea.topic.shipping": "Shipping",
  "plan.idea.topic.shippingPrompt": "Shipping: ",
  "plan.idea.topic.pdp": "Product page",
  "plan.idea.topic.pdpPrompt": "On the product page, ",
  "plan.idea.topic.checkout": "Checkout",
  "plan.idea.topic.checkoutPrompt": "In the checkout, ",
  "plan.idea.topic.search": "Search",
  "plan.idea.topic.searchPrompt": "In the search, ",
  "plan.idea.topic.performance": "Performance",
  "plan.idea.topic.performancePrompt": "To make the store faster, ",
  "plan.idea.topic.paidMedia": "Paid media",
  "plan.idea.topic.paidMediaPrompt": "For people coming from paid media, ",
  "plan.prompt.withObjective":
    "Build a business case for this idea. Follow the business-case skill (read /app/org/public/core/business-case/SKILL.md) and save the document in the organization files.\n\nStore goal: {objective}\n\nIdea: {idea}",
  "plan.prompt.suggestObjective":
    'Suggest a goal for my store, the one sentence every plan starts from. Do not ask me questions first.\n\n1. Read what you can reach about the store: the Monitor (visitors, pageviews, orders and alerts), the funnel and orders through this organization\'s tools, and the files in /app/org/home.\n2. Propose one sentence of up to {max} characters, the way I would say it to my team (e.g. "Sell as well on mobile as on desktop, without spending more on media.").\n3. Under it, give 2 or 3 reasons. Each number carries its source and window ("33% start checkout, store data lake, last 7 days"); a number you did not read does not go in.\n4. Say which data you could not reach. If you found nothing, still propose a sentence and say it is an assumption.\n5. Do not save it yet. Ask if I approve it or want to change it. Only after I approve, save it with ORGANIZATION_PLAN_OBJECTIVE_SET, using my version if I changed it.\n\nReply in the language of this message.',
  "plan.prompt.withoutObjective":
    "Build a business case for this idea. Follow the business-case skill (read /app/org/public/core/business-case/SKILL.md) and save the document in the organization files.\n\nIdea: {idea}",
};
