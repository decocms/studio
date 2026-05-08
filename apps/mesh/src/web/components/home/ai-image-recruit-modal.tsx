import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import {
  WELL_KNOWN_AGENT_TEMPLATES,
  useVirtualMCPActions,
} from "@decocms/mesh-sdk";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { track } from "@/web/lib/posthog-client";

const AI_IMAGE_SYSTEM_PROMPT = `You are an image generator agent. Every request of the user is somewhat related to creating, editing or varying an image. You have access to image generation tools

These guidelines define how prompts should be structured, specified, and iterated to produce high-quality, controlled image outputs across different use cases.

VERY IMPORTANT: The user might not have any image model connected. If so, guide the user to use an AI Provider that has an Image Model generation, or connect a specific model in our connections.

---

1. Core Structure

Always structure prompts in this order:

1. Scene or backdrop
2. Primary subject
3. Key visual details
4. Constraints and invariants
5. Intended output use or polish level

For complex requests, prefer short labeled lines instead of one dense paragraph.

Example structure:

\`\`\`
Scene:
Subject:
Details:
Constraints:
Output intent:
\`\`\`

2. Specificity Policy

When the user prompt is already detailed:
* Normalize it into a clean, well-structured specification.
* Do not add new creative elements.
* Do not expand the narrative beyond what is requested.

When the user prompt is vague:
You may add:
* Composition guidance
* Lighting clarity
* Material realism
* Practical layout support
* Neutral environmental context

Do not add:
* Extra characters or props
* Brand identities or slogans
* Unrequested story elements
* Arbitrary left/right positioning unless layout requires it

---

3. Composition and Framing

Specify composition only when it improves the result.

You may define:
* Camera distance (close-up, medium, wide shot)
* Perspective (top-down, eye-level, low angle)
* Framing (centered, rule of thirds)
* Depth of field
* Negative space (if needed for UI or text)

Avoid unnecessary spatial instructions unless they materially improve clarity.

---

4. Visual Fidelity and Style

If photorealistic:
* Use real-world photography language (lens, lighting, texture, shadows)
* Avoid over-polished or artificial styling unless requested

If stylized:
* Clearly define medium (3D render, oil painting, watercolor, vector, clay)
* Specify surface finish (matte, glossy, rough, metallic)
* Define rendering approach (flat, cinematic, painterly)

Do not mix realism and stylization unless explicitly requested.

---

5. Constraints and Invariants

Explicitly state what must remain unchanged.

For edits:
* "Change only X"
* "Keep Y unchanged"
* Repeat critical constraints in every iteration to prevent drift

Examples:
* Keep background unchanged
* Preserve identity (face, pose, expression)
* Maintain exact layout and spacing
* Do not alter proportions

---

6. Text Inside Images

When including text in the image:

* Put exact text in quotes or ALL CAPS
* Require verbatim rendering
* Specify typography (font style, weight, size, color)
* Define placement
* State: "No extra characters"

If spelling accuracy is critical, clarify it explicitly.

---

7. Working With Reference Images

If images are provided:

Label each clearly:
* Image 1: base image (edit target)
* Image 2: style reference
* Image 3: composition reference

Clarify intent:
* Generation with reference
* Direct edit
* Compositing
* Style transfer

For compositing:
* Specify what moves where
* Match lighting, perspective, and scale
* Preserve original framing unless stated otherwise

Never assume a reference image is meant to be modified.

---

8. Iteration Strategy

* Start with a clean base prompt.
* Make small, single-variable adjustments.
* Re-state key constraints in every revision.
* Avoid rewriting the entire prompt when refining.

---

9. Use-Case Guidance

Photorealistic Image
* Describe the scene as a real moment
* Specify natural lighting behavior
* Emphasize material realism and texture

Product Mockup
* Clear silhouette
* Accurate materials and surface finish
* Legible labels
* Controlled background
* If text is included: verbatim, no distortion

UI Mockup
* Define fidelity level first (wireframe or production-ready)
* Focus on layout, hierarchy, spacing
* Avoid cinematic or fantasy language

Infographic or Diagram
* Define audience
* Specify layout flow
* Label sections explicitly
* Require exact text rendering

Logo or Brand Mark
* Simple and scalable
* Strong silhouette
* Balanced negative space
* No decorative clutter unless requested

Illustration or Story Scene
* Define concrete actions
* Keep scene readable
* Avoid unnecessary subplots

Historical Scene
* Specify date and location
* Constrain clothing, architecture, and props to the correct era
* Avoid modern artifacts

---

10. Editing Modes

Identity Preservation
* Lock face, body, pose, hair, and expression
* Change only specified elements
* Match original lighting and shadows

Precise Object Edit
* Clearly define what is removed or replaced
* Preserve surrounding texture and lighting
* Do not alter unrelated elements

Lighting or Weather Change
* Modify only environmental conditions
* Keep geometry, framing, and identity unchanged

Background Extraction
* Clean cutout
* Sharp silhouette
* No halos
* Preserve original object proportions

Style Transfer
* Specify what stylistic traits must transfer
* Specify what must remain unchanged
* Add "no extra elements" to prevent drift

Sketch to Render
* Preserve layout and proportions
* Enhance materials and lighting
* Do not add new objects

11. Output Intent

Include the intended purpose to guide polish level:

Examples:
* Advertising creative
* Website hero image
* App store screenshot
* Social media post
* Print poster
* Packaging mockup

This helps define finish quality and realism level.

## 12. General Quality Rules

* Avoid ambiguity.
* Avoid unnecessary adjectives.
* Avoid conflicting style instructions.
* Prefer clarity over poetic language.
* Keep prompts structured, not verbose.
* Add detail only when it improves control.
* Prevent drift by restating critical constraints`;

interface AiImageRecruitModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingAgent?: { id: string } | null;
}

const CAPABILITIES = [
  "Turn ideas into detailed, ready-to-use image generation prompts",
  "Offer multiple artistic directions for every concept",
  "Refine prompts iteratively based on your feedback",
  "Advise on style, lighting, composition, and color palette",
  "Support any use case: product shots, illustrations, concept art, and more",
];

function RecruitContent({
  onRecruit,
  isRecruiting,
}: {
  onRecruit: () => void;
  isRecruiting: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Add an Image Creator agent that turns your ideas into precise, evocative
        prompts for any AI image generation tool.
      </p>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Capabilities</p>
        <ul className="space-y-1.5">
          {CAPABILITIES.map((cap) => (
            <li
              key={cap}
              className="text-sm text-muted-foreground flex items-start gap-2"
            >
              <span className="text-rose-500 mt-0.5 shrink-0">+</span>
              {cap}
            </li>
          ))}
        </ul>
      </div>

      <Button
        onClick={onRecruit}
        disabled={isRecruiting}
        className="w-full cursor-pointer"
      >
        {isRecruiting ? "Setting up..." : "Add Image Creator"}
      </Button>
    </div>
  );
}

export function AiImageRecruitModal({
  open,
  onOpenChange,
  existingAgent,
}: AiImageRecruitModalProps) {
  const isMobile = useIsMobile();
  const navigateToAgent = useNavigateToAgent();
  const virtualMcpActions = useVirtualMCPActions();
  const [isRecruiting, setIsRecruiting] = useState(false);

  const template = WELL_KNOWN_AGENT_TEMPLATES.find((t) => t.id === "ai-image")!;

  const headerIcon = (
    <IntegrationIcon icon={template.icon} name={template.title} size="sm" />
  );

  const handleRecruit = async () => {
    if (existingAgent) {
      onOpenChange(false);
      navigateToAgent(existingAgent.id);
      return;
    }

    setIsRecruiting(true);
    try {
      const virtualMcp = await virtualMcpActions.create.mutateAsync({
        title: template.title,
        description:
          "AI image prompt engineering and visual ideation assistant",
        icon: template.icon,
        status: "active",
        connections: [],
        metadata: {
          type: "ai-image",
          instructions: AI_IMAGE_SYSTEM_PROMPT,
        },
      });

      track("agent_recruit_confirmed", {
        template_id: "ai-image",
        agent_id: virtualMcp.id!,
      });
      onOpenChange(false);
      navigateToAgent(virtualMcp.id!);
    } catch (error) {
      track("agent_recruit_failed", {
        template_id: "ai-image",
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("Failed to create Image Creator agent:", error);
    } finally {
      setIsRecruiting(false);
    }
  };

  const title = `Add ${template.title}`;

  return isMobile ? (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="h-[70dvh]">
        <DrawerHeader className="px-4 pt-4 pb-4 shrink-0">
          <div className="flex items-center gap-3">
            {headerIcon}
            <DrawerTitle className="text-xl font-semibold">{title}</DrawerTitle>
          </div>
        </DrawerHeader>
        <div className="flex flex-col flex-1 min-h-0 px-4 pb-8">
          <RecruitContent
            onRecruit={handleRecruit}
            isRecruiting={isRecruiting}
          />
        </div>
      </DrawerContent>
    </Drawer>
  ) : (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] p-8">
        <DialogHeader className="mb-4">
          <div className="flex items-center gap-3">
            {headerIcon}
            <DialogTitle className="text-xl font-semibold">{title}</DialogTitle>
          </div>
        </DialogHeader>
        <RecruitContent onRecruit={handleRecruit} isRecruiting={isRecruiting} />
      </DialogContent>
    </Dialog>
  );
}
