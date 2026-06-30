import { MultivariateFieldWrapper } from "./multivariate-field-wrapper";
import { StringField } from "./string-field";
import type { FieldProps } from "./field-props";

function extractStringValue(value: unknown): string {
  if (typeof value === "string") return value;
  return "";
}

interface MultivariateStringFieldProps extends FieldProps {
  multivariateResolveType: string;
}

export function MultivariateStringField({
  multivariateResolveType,
  ...props
}: MultivariateStringFieldProps) {
  return (
    <MultivariateFieldWrapper
      {...props}
      multivariateResolveType={multivariateResolveType}
      extractValue={extractStringValue}
      renderPlainField={(p) => <StringField {...p} />}
      renderVariantField={(p) => <StringField {...p} />}
    />
  );
}
