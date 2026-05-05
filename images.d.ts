// PNG imports vary between bundlers: Webpack and `next build` return
// StaticImageData ({ src, width, height, ... }), while Turbopack-dev sometimes
// returns the raw URL string. Declare the union and let consumers normalize.
declare module "*.png" {
  const value:
    | string
    | {
        src: string;
        height: number;
        width: number;
        blurDataURL?: string;
        blurWidth?: number;
        blurHeight?: number;
      };
  export default value;
}
