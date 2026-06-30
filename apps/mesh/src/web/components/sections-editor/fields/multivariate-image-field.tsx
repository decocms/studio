import { MultivariateFieldWrapper } from "./multivariate-field-wrapper";
import { ImageField } from "./image-field";
import { extractUrl } from "./extract-url";
import type { FieldProps } from "./field-props";

interface MultivariateImageFieldProps extends FieldProps {
  multivariateResolveType: string;
}

export function MultivariateImageField({
  multivariateResolveType,
  ...props
}: MultivariateImageFieldProps) {
  return (
    <MultivariateFieldWrapper
      {...props}
      multivariateResolveType={multivariateResolveType}
      extractValue={extractUrl}
      renderPlainField={(p) => <ImageField {...p} />}
      renderVariantField={(p) => <ImageField {...p} />}
    />
  );
}
