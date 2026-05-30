/* eslint-disable ban-memoization/ban-memoization */
"use client";

import type * as React from "react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
} from "react";
import { z } from "zod";
import { Badge } from "./badge.tsx";
import { Button } from "./button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { X } from "@untitledui/icons";

// Email validation schema
const emailSchema = z.string().email("Invalid email address");

// Email validation types
export type EmailValidationState = "valid" | "invalid" | "self";

export interface EmailValidation {
  validate?: (email: string) => EmailValidationState;
  currentUserEmail?: string;
}

export interface EmailTagsInputProps {
  emails: string[];
  onEmailsChange: (emails: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  validation?: EmailValidation;
  onToast?: (message: string, type: "success" | "error" | "info") => void;
  /**
   * Custom className for email badge chips
   * Useful for adjusting padding or styling
   * @example "px-1 py-0.5" for tighter spacing
   */
  badgeClassName?: string;
}

/**
 * Imperative handle for EmailTagsInput
 * Allows parent components to flush pending input before form submission
 */
export interface EmailTagsInputHandle {
  /**
   * Flush any pending input in the text field, adding it as an email
   * Useful to call before form submission to ensure typed but not-yet-added emails are included
   */
  flushPending: () => void;
}

/**
 * EmailTagsInput - A composable input component for managing multiple email addresses
 *
 * Features:
 * - Multiple email input with tag/chip display
 * - Paste support for bulk email addition
 * - Email validation with visual feedback
 * - Support for multiple delimiters (comma, semicolon, newline, etc.)
 * - Accessible and keyboard-friendly
 *
 * Usage:
 * ```tsx
 * const inputRef = useRef<EmailTagsInputHandle>(null);
 *
 * const handleSubmit = () => {
 *   inputRef.current?.flushPending(); // Ensure any typed email is added
 *   // ... submit logic
 * };
 *
 * <EmailTagsInput
 *   ref={inputRef}
 *   emails={emails}
 *   onEmailsChange={setEmails}
 *   validation={{ currentUserEmail: user.email }}
 *   onToast={(msg, type) => toast[type](msg)}
 * />
 * ```
 */
export const EmailTagsInput = forwardRef<
  EmailTagsInputHandle,
  EmailTagsInputProps
>(function EmailTagsInput(
  {
    emails,
    onEmailsChange,
    disabled,
    placeholder = "Emails, comma separated",
    validation,
    onToast,
    badgeClassName,
  },
  ref,
) {
  const [inputValue, setInputValue] = useState("");
  const [emailStates, setEmailStates] = useState<
    Map<string, EmailValidationState>
  >(new Map());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const addEmailRef = useRef<(email: string) => boolean>(() => false);

  const validateEmail = useCallback(
    (email: string): EmailValidationState => {
      const trimmedEmail = email.trim().toLowerCase();

      // Use custom validation if provided
      if (validation?.validate) {
        return validation.validate(trimmedEmail);
      }

      // Default validation
      if (
        validation?.currentUserEmail &&
        trimmedEmail === validation.currentUserEmail.toLowerCase()
      ) {
        return "self";
      }

      if (!emailSchema.safeParse(trimmedEmail).success) {
        return "invalid";
      }

      return "valid";
    },
    [validation],
  );

  const addEmail = useCallback(
    (email: string) => {
      const trimmedEmail = email.trim().toLowerCase();
      if (!trimmedEmail) return false;

      // Check if email already exists
      if (emails.includes(trimmedEmail)) {
        return false;
      }

      // Validate email
      const state = validateEmail(trimmedEmail);

      // Add email regardless of validation state (so user can see error)
      const newEmails = [...emails, trimmedEmail];
      onEmailsChange(newEmails);

      // Update validation state
      setEmailStates((prev) => {
        const next = new Map(prev);
        next.set(trimmedEmail, state);
        return next;
      });

      return true;
    },
    [emails, onEmailsChange, validateEmail],
  );

  // Keep ref updated with current addEmail function
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  addEmailRef.current = addEmail;

  // Expose imperative handle for parent to flush pending input
  useImperativeHandle(
    ref,
    () => ({
      flushPending: () => {
        if (inputValue.trim()) {
          addEmailRef.current(inputValue);
          setInputValue("");
        }
      },
    }),
    [inputValue],
  );

  const removeEmail = useCallback(
    (emailToRemove: string) => {
      const newEmails = emails.filter((email) => email !== emailToRemove);
      onEmailsChange(newEmails);

      // Remove from validation states
      setEmailStates((prev) => {
        const next = new Map(prev);
        next.delete(emailToRemove);
        return next;
      });
    },
    [emails, onEmailsChange],
  );

  const processEmailList = useCallback(
    (text: string) => {
      // Split by various delimiters, clean up and filter empty strings
      const potentialEmails = text
        .split(/[,;\n\r\t|]/)
        .map((email) => email.trim())
        .filter((email) => email.length > 0);

      let addedCount = 0;
      let totalEmails = 0;
      const newEmailsToAdd: string[] = [];
      const newEmailStates = new Map<string, EmailValidationState>();

      potentialEmails.forEach((email) => {
        totalEmails++;
        const trimmedEmail = email.trim().toLowerCase();

        // Skip if email already exists in current list or in new emails to add
        if (
          emails.includes(trimmedEmail) ||
          newEmailsToAdd.includes(trimmedEmail)
        ) {
          return;
        }

        // Validate email
        const state = validateEmail(trimmedEmail);

        // Add to our list regardless of validation state (so user can see errors)
        newEmailsToAdd.push(trimmedEmail);
        newEmailStates.set(trimmedEmail, state);
        addedCount++;
      });

      // Update all emails at once to avoid race conditions
      if (newEmailsToAdd.length > 0) {
        const allEmails = [...emails, ...newEmailsToAdd];
        onEmailsChange(allEmails);

        // Update validation states
        setEmailStates((prev) => {
          const next = new Map(prev);
          newEmailStates.forEach((state, email) => {
            next.set(email, state);
          });
          return next;
        });
      }

      // Only clear input if we actually processed emails from it
      if (totalEmails > 0) {
        setInputValue("");

        if (addedCount > 0 && onToast) {
          onToast(
            `Added ${addedCount} email${addedCount > 1 ? "s" : ""}`,
            "success",
          );
        } else if (totalEmails > addedCount && onToast) {
          // Some emails were not added (duplicates or invalid)
          onToast(
            `${totalEmails - addedCount} email${
              totalEmails - addedCount > 1 ? "s were" : " was"
            } already added or invalid`,
            "info",
          );
        }
      }

      return addedCount;
    },
    [emails, onEmailsChange, validateEmail, onToast],
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;

    // Check if there are delimiters in the current input
    const hasDelimiters = /[,;\n\r\t|]/.test(value);

    if (hasDelimiters) {
      // Process the emails
      processEmailList(value);
    } else {
      // No delimiters, just update the input value
      setInputValue(value);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (inputValue.trim()) {
        if (addEmail(inputValue)) {
          setInputValue("");
        }
      }
    } else if (e.key === "Backspace" && !inputValue && emails.length > 0) {
      // Remove last email when backspace is pressed on empty input
      const lastEmail = emails[emails.length - 1];
      if (lastEmail) {
        removeEmail(lastEmail);
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedText = e.clipboardData.getData("text");

    // Always process pasted content for emails
    if (pastedText.trim()) {
      e.preventDefault();

      // If pasted text contains delimiters, process as email list
      if (/[,;\n\r\t|]/.test(pastedText)) {
        processEmailList(pastedText);
      } else {
        // Single email, add it
        if (addEmail(pastedText.trim())) {
          // Don't clear input here, let normal flow handle it
        } else {
          // Failed to add, put it in input for user to see/edit
          setInputValue(pastedText.trim());
        }
      }
    }
  };

  // Auto-resize textarea
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height =
        Math.max(96, Math.min(200, textarea.scrollHeight)) + "px"; // Min 4 lines (24px * 4 = 96px)
    }
  }, []);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    adjustTextareaHeight();
  }, [inputValue, adjustTextareaHeight]);

  // Get error messages for display
  const invalidEmails = useMemo(
    () => emails.filter((email) => emailStates.get(email) === "invalid"),
    [emails, emailStates],
  );

  const selfEmails = useMemo(
    () => emails.filter((email) => emailStates.get(email) === "self"),
    [emails, emailStates],
  );

  const getBadgeVariant = (email: string) => {
    const state = emailStates.get(email);
    switch (state) {
      case "invalid":
      case "self":
        return "destructive";
      default:
        return "secondary";
    }
  };

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "min-h-[96px] w-full rounded-xl border border-input bg-background px-3 py-2 text-sm transition-[color,box-shadow]",
          "focus-within:border-ring focus-within:ring-ring/20 focus-within:ring-[2px]",
          disabled && "opacity-50 cursor-not-allowed",
        )}
        onClick={() => textareaRef.current?.focus()}
      >
        <div className="flex flex-wrap gap-1 items-start">
          {emails.map((email) => (
            <Badge
              key={email}
              variant={getBadgeVariant(email)}
              className={cn(
                "flex items-center gap-1 max-w-xs",
                badgeClassName || "px-1 py-0.5", // Default to tighter spacing
              )}
            >
              <span className="truncate">{email}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "h-4 w-4 rounded-full transition-colors",
                  getBadgeVariant(email) === "destructive"
                    ? "text-destructive hover:text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  removeEmail(email);
                }}
                disabled={disabled}
              >
                <X size={12} />
              </Button>
            </Badge>
          ))}
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            className="flex-1 min-w-[120px] bg-transparent border-none outline-none resize-none placeholder:text-muted-foreground overflow-hidden"
            placeholder={
              emails.length === 0 ? placeholder : "Add more emails..."
            }
            disabled={disabled}
            rows={4}
            style={{
              minHeight: "96px", // 4 lines minimum
              maxHeight: "200px",
            }}
          />
        </div>
      </div>

      {/* Show validation errors */}
      {selfEmails.length > 0 && (
        <div className="text-sm text-destructive">
          You're not able to send an invite to yourself: {selfEmails.join(", ")}
        </div>
      )}

      {invalidEmails.length > 0 && (
        <div className="text-sm text-destructive">
          Invalid email format: {invalidEmails.join(", ")}
        </div>
      )}
    </div>
  );
});
