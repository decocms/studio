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
  "plan.objective.deciding": "Reading the store's data to pick its goal…",
  "plan.objective.pickedByAi":
    "Picked by AI from the store's last 28 days. Edit it if it does not fit.",
  "plan.objective.review": "Review with AI",
  "plan.objective.reviewing": "Reviewing…",
  "plan.objective.review.same":
    "The store's data still points to the same goal.",
  "plan.objective.review.updated": "Goal updated from the store's data.",
  "plan.objective.review.noData":
    "Not enough store data yet to pick a goal. The goal stays as it is.",
  "plan.objective.review.unavailable":
    "The AI could not review the goal right now. Try again later.",
  "plan.objective.review.uncertain":
    "The store's data does not point to a clear goal. The goal stays as it is.",
  "plan.goal.mobile_conversion": "Make mobile sell as well as desktop.",
  "plan.goal.checkout_completion":
    "Get more shoppers who start checkout to finish the purchase.",
  "plan.goal.cart_to_checkout": "Take more carts through to checkout.",
  "plan.goal.product_to_cart":
    "Turn more product page views into items in the cart.",
  "plan.goal.traffic_growth": "Win back the visitors the store lost.",
  "plan.goal.recover_sales": "Recover the sales that fell.",
  "plan.goal.average_ticket": "Raise the average order value.",
  "plan.goal.site_stability": "Stop losing sales to site errors.",
  "plan.idea.heading": "What do you want to improve in the store?",
  "plan.idea.description":
    "Say it however it comes to you, even vaguely. A few quick questions fill in what only you know, then the agent builds the case: the problem in numbers, who already does it, the money at stake, effort and the A/B test.",
  "plan.idea.label": "Your idea",
  "plan.idea.placeholder":
    "E.g. I want to improve search. Or: a fit guide on the product page would raise conversion.",
  "plan.idea.submit": "Build the business case",
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
    "Let's build a business case for this request together. Follow the business-case skill (read /app/org/public/core/business-case/SKILL.md). The canvas for this case is {casePath}: run init now, before anything else, and fill the cards as we go. If the request does not say where and what, ask me one thing at a time, with options.\n\nStore goal: {objective}\n\nRequest: {idea}",
  "plan.prompt.suggestObjective":
    'Suggest a goal for my store, the one sentence every plan starts from. Do not ask me questions first.\n\n1. Read what you can reach about the store: the Monitor (visitors, pageviews, orders and alerts), the funnel and orders through this organization\'s tools, and the files in /app/org/home.\n2. Propose one sentence of up to {max} characters, the way I would say it to my team (e.g. "Sell as well on mobile as on desktop, without spending more on media.").\n3. Under it, give 2 or 3 reasons. Each number carries its source and window ("33% start checkout, store data lake, last 7 days"); a number you did not read does not go in.\n4. Say which data you could not reach. If you found nothing, still propose a sentence and say it is an assumption.\n5. Do not save it yet. Ask if I approve it or want to change it. Only after I approve, save it with ORGANIZATION_PLAN_OBJECTIVE_SET, using my version if I changed it.\n\nReply in the language of this message.',
  "plan.prompt.withoutObjective":
    "Let's build a business case for this request together. Follow the business-case skill (read /app/org/public/core/business-case/SKILL.md). The canvas for this case is {casePath}: run init now, before anything else, and fill the cards as we go. If the request does not say where and what, ask me one thing at a time, with options.\n\nRequest: {idea}",
  "plan.case.waiting": "Opening the business case…",
  "plan.case.asking": "Answer in the chat",
  "plan.case.assumption": "Assumption:",
  "plan.case.progress": "{filled} of {total} filled",
  "plan.case.openDocument": "Open the document",
  "plan.case.invalid":
    "The latest update could not be read; showing the one before it.",
  "plan.case.objective": "Store goal",
  "plan.case.noObjective": "No goal yet. Write one on the Plan page.",
  "plan.case.request": "What you asked",
  "plan.case.status.framing": "Framing",
  "plan.case.status.building": "Building",
  "plan.case.status.ready": "Ready",
  "plan.case.area.pdp": "Product page",
  "plan.case.area.search": "Search",
  "plan.case.area.category": "Category page",
  "plan.case.area.home": "Home page",
  "plan.case.area.cart": "Cart",
  "plan.case.area.checkout": "Checkout",
  "plan.case.area.shipping": "Shipping",
  "plan.case.area.performance": "Performance",
  "plan.case.area.paidMedia": "Paid media",
  "plan.case.area.other": "Other",
  "plan.case.card.problem": "The problem, measured",
  "plan.case.card.problemQuestion":
    "Which step of the journey loses people, and how many?",
  "plan.case.card.scope": "What we will change",
  "plan.case.card.scopeQuestion":
    "Where in the store, on which device, and what exactly?",
  "plan.case.card.money": "Money at stake",
  "plan.case.card.moneyQuestion":
    "How much is a small gain on that step worth per month?",
  "plan.case.card.competitors": "Who already does it",
  "plan.case.card.competitorsQuestion":
    "Which competitors already do this, and how?",
  "plan.case.card.measurement": "How we measure",
  "plan.case.card.measurementQuestion":
    "Which metric proves it worked, and which must not get worse?",
  "plan.case.card.abTest": "A/B test and timeline",
  "plan.case.card.abTestQuestion":
    "How many people and how many weeks to know?",
  "plan.case.card.effort": "Effort and deliveries",
  "plan.case.card.effortQuestion":
    "How many days of work, and what changes in the store?",
  "plan.case.card.risks": "Risks",
  "plan.case.card.risksQuestion": "What could get worse, and what do we watch?",
  "plan.case.card.unknowns": "What we still don't know",
  "plan.case.card.unknownsQuestion": "What is missing, and how do we find out?",
  "plan.cases.heading": "Your business cases",
  "plan.cases.description": "Open one to see the canvas and keep talking.",
  "plan.cases.updated": "Updated {when}",
  "plan.cases.unreadable": "Could not read this case",
  "plan.prompt.skipped":
    "(skipped: assume it and write the assumption on the card)",
  "plan.prompt.guidedAnswers":
    "Before this chat I already answered the questions only I could answer. Do not ask them again, and do not ask me anything else unless something blocks the case: fill the cards these answers cover first, then research.\n\n{answers}",
  "plan.prompt.guidedNothing":
    "Before this chat I was asked whether anything only I know was missing, and nothing was. Do not ask me questions unless something blocks the case: assume, write the assumption on the card, and research.",
  "plan.guide.thinking1": "Hmm, interesting idea…",
  "plan.guide.thinking2": "Thinking about the next steps…",
  "plan.guide.thinking3": "Let me see what is missing here…",
  "plan.guide.thinking4": "This is good, let me shape it…",
  "plan.guide.thinking5": "Putting the pieces together…",
  "plan.guide.thinking6": "Hmm, there is something nice in this…",
  "plan.guide.thinking7": "Sorting out the ideas…",
  "plan.guide.thinking8": "One second, thinking…",
  "plan.guide.building1": "Building your business case…",
  "plan.guide.building2": "Calling the agent to research the numbers…",
  "plan.guide.building3": "Getting the cards ready…",
  "plan.guide.yourIdea": "Your idea",
  "plan.guide.answerLabel": "Your answer",
  "plan.guide.answerPlaceholder": "Write it your way…",
  "plan.guide.continue": "Continue",
  "plan.guide.skip": "Skip this one",
  "plan.guide.back": "Back",
};
