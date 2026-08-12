import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "./carousel.tsx";

const templates = [
  {
    title: "Customer support agent",
    description: "Answers tickets using your docs and past conversations.",
  },
  {
    title: "Sales enrichment",
    description: "Enriches inbound leads with firmographic data.",
  },
  {
    title: "Release notes writer",
    description: "Drafts release notes from merged pull requests.",
  },
  {
    title: "Onboarding checklist",
    description: "Guides new members through workspace setup.",
  },
  {
    title: "Data sync monitor",
    description: "Watches warehouse syncs and flags failures.",
  },
];

const meta = {
  title: "Components/Carousel",
  component: Carousel,
} satisfies Meta<typeof Carousel>;

export default meta;
type Story = StoryObj<typeof meta>;

function TemplateCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-40 flex-col justify-between rounded-xl border border-border bg-background p-4">
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <p className="text-xs text-muted-foreground">Template</p>
    </div>
  );
}

export const Default: Story = {
  render: () => (
    <Carousel className="w-full max-w-sm">
      <CarouselContent>
        {templates.map((template) => (
          <CarouselItem key={template.title}>
            <TemplateCard {...template} />
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  ),
};

export const MultipleItems: Story = {
  render: () => (
    <Carousel opts={{ align: "start" }} className="w-full max-w-2xl">
      <CarouselContent>
        {templates.map((template) => (
          <CarouselItem key={template.title} className="basis-1/3">
            <TemplateCard {...template} />
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  ),
};

export const Vertical: Story = {
  render: () => (
    <Carousel orientation="vertical" className="w-full max-w-sm">
      <CarouselContent className="h-48">
        {templates.map((template) => (
          <CarouselItem key={template.title}>
            <TemplateCard {...template} />
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  ),
};
